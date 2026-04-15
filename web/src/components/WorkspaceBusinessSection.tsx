import { Avatar, Button, Descriptions, Empty, Input, InputNumber, Select, Space, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type {
  AiServiceDetailResponse,
  DistributionSourceDetailResponse,
  DistributionSupplyDetailResponse,
  FundAccountsDetailResponse,
  FundWithdrawalsDetailResponse,
  OpenLogsDetailResponse,
  SystemMonitoringDetailResponse,
  SystemAccountsDetailResponse,
  SystemConfigsDetailResponse,
  SystemUserRole,
  WorkspaceBusinessDetailResponse,
  WorkspaceBusinessMetric,
} from '../api';
import { AiServiceChatWorkspacePanel } from './AiServiceChatWorkspacePanel';
import { SecurityWorkspaceSection } from './SecurityWorkspaceSection';

function renderMetrics(metrics: WorkspaceBusinessMetric[]) {
  return (
    <div className="workspace-business-metrics">
      {metrics.map((metric) => (
        <div className="workspace-business-metric-card" key={metric.label}>
          <div className="workspace-business-metric-label">{metric.label}</div>
          <div className="workspace-business-metric-value">
            {metric.value}
            <span className="workspace-business-metric-unit">{metric.unit}</span>
          </div>
          <div className="workspace-business-metric-helper">{metric.helper}</div>
        </div>
      ))}
    </div>
  );
}

function AiServiceChatPanel({
  detail,
  props,
}: {
  detail: AiServiceDetailResponse;
  props: WorkspaceBusinessSectionProps;
}) {
  const [searchText, setSearchText] = useState('');
  const [conversationFilter, setConversationFilter] = useState<AiServiceConversationFilter>('all');
  const [selectedConversationId, setSelectedConversationId] = useState<number | null>(null);
  const [sidebarTab, setSidebarTab] = useState<AiServiceSidebarTab>('service');
  const [draftsByConversationId, setDraftsByConversationId] = useState<Record<number, string>>({});

  const latestMessageMap = useMemo(() => {
    const map = new Map<number, AiServiceMessage>();
    const sortedMessages = [...detail.recentMessages].sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id - right.id,
    );
    for (const message of sortedMessages) {
      map.set(message.conversationId, message);
    }
    return map;
  }, [detail.recentMessages]);

  const filterCounts = useMemo(
    () => ({
      all: detail.conversations.length,
      manual: detail.conversations.filter((item) => item.conversationStatus === 'manual_active').length,
      risk: detail.conversations.filter((item) => item.riskLevel === 'high').length,
      closed: detail.conversations.filter((item) => item.conversationStatus === 'resolved').length,
    }),
    [detail.conversations],
  );

  const filteredConversations = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    return detail.conversations.filter((conversation) => {
      const matchesKeyword =
        !keyword ||
        [
          conversation.customerName,
          conversation.topic,
          conversation.storeName ?? '',
          conversation.orderNo ?? '',
          conversation.caseNo ?? '',
          conversation.latestUserIntent,
          conversation.tags.join(' '),
        ]
          .join(' ')
          .toLowerCase()
          .includes(keyword);

      const matchesFilter =
        conversationFilter === 'all'
          ? true
          : conversationFilter === 'manual'
            ? conversation.conversationStatus === 'manual_active'
            : conversationFilter === 'risk'
              ? conversation.riskLevel === 'high'
              : conversation.conversationStatus === 'resolved';

      return matchesKeyword && matchesFilter;
    });
  }, [conversationFilter, detail.conversations, searchText]);

  const fallbackConversationId = filteredConversations[0]?.id ?? detail.conversations[0]?.id ?? null;

  const selectedConversation = useMemo(
    () => {
      const currentSelection =
        detail.conversations.find((item) => item.id === selectedConversationId) ?? null;
      if (
        currentSelection &&
        (filteredConversations.length === 0 || filteredConversations.some((item) => item.id === currentSelection.id))
      ) {
        return currentSelection;
      }
      return detail.conversations.find((item) => item.id === fallbackConversationId) ?? null;
    },
    [detail.conversations, fallbackConversationId, filteredConversations, selectedConversationId],
  );

  const selectedMessages = useMemo(
    () =>
      detail.recentMessages
        .filter((message) => message.conversationId === selectedConversation?.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id - right.id),
    [detail.recentMessages, selectedConversation?.id],
  );

  const selectedTakeovers = useMemo(
    () =>
      detail.takeovers
        .filter((item) => item.conversationId === selectedConversation?.id)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id - left.id)
        .slice(0, 5),
    [detail.takeovers, selectedConversation?.id],
  );

  const quickReplyCards = useMemo(
    () => [
      ...detail.replyTemplates.map((item) => ({
        key: `template-${item.id}`,
        kind: 'template' as const,
        id: item.id,
        title: item.title,
        subtitle: item.scene,
        content: item.templateContent,
        enabled: item.enabled,
      })),
      ...detail.knowledgeItems.map((item) => ({
        key: `knowledge-${item.id}`,
        kind: 'knowledge' as const,
        id: item.id,
        title: item.title,
        subtitle: item.category,
        content: item.answerText,
        enabled: item.enabled,
      })),
    ],
    [detail.knowledgeItems, detail.replyTemplates],
  );

  const quickComposerCards = quickReplyCards.filter((item) => item.enabled).slice(0, 4);
  const currentDraft = selectedConversation ? draftsByConversationId[selectedConversation.id] ?? '' : '';

  const filterOptions: Array<{ key: AiServiceConversationFilter; label: string; count: number }> = [
    { key: 'all', label: '全部', count: filterCounts.all },
    { key: 'manual', label: '待人工', count: filterCounts.manual },
    { key: 'risk', label: '高风险', count: filterCounts.risk },
    { key: 'closed', label: '已结单', count: filterCounts.closed },
  ];

  const sidebarTabs: Array<{ key: AiServiceSidebarTab; label: string }> = [
    { key: 'service', label: '客服' },
    { key: 'quick-reply', label: '快捷回复' },
    { key: 'product', label: '商品' },
    { key: 'order', label: '订单' },
    { key: 'customer', label: '客户' },
  ];

  const applyQuickReply = (content: string) => {
    const nextContent = content.trim();
    if (!nextContent || !selectedConversation) {
      return;
    }
    setDraftsByConversationId((current) => {
      const previousDraft = current[selectedConversation.id] ?? '';
      return {
        ...current,
        [selectedConversation.id]: previousDraft.trim() ? `${previousDraft.trim()}\n${nextContent}` : nextContent,
      };
    });
  };

  const handleSendManualReply = (closeConversation: boolean) => {
    if (!selectedConversation || !currentDraft.trim()) {
      return;
    }
    const nextDraft = currentDraft.trim();
    void props
      .onSendAiServiceManualReply(selectedConversation.id, nextDraft, closeConversation)
      .then(() =>
        setDraftsByConversationId((current) => ({
          ...current,
          [selectedConversation.id]: '',
        })),
      );
  };

  const isSendBusy = selectedConversation
    ? props.busyKey === `ai-manual-${selectedConversation.id}` ||
      props.busyKey === `ai-manual-close-${selectedConversation.id}`
    : false;

  return (
    <div className="module-panel ai-service-chat-panel">
      <div className="ai-service-chat-appbar">
        <div className="ai-service-chat-appbar-tabs">
          <div className="ai-service-chat-app-tab ai-service-chat-app-tab-brand">
            <span className="ai-service-chat-app-icon">鱼</span>
            <div>
              <strong>闲鱼客服</strong>
              <small>真实会话面板</small>
            </div>
          </div>
          <div className="ai-service-chat-app-tab is-active">
            <Avatar size={30} className="ai-service-chat-session-avatar ai-service-chat-app-avatar">
              {buildAiServiceInitials(selectedConversation?.storeName ?? detail.title)}
            </Avatar>
            <div>
              <strong>{selectedConversation?.storeName ?? detail.title}</strong>
              <small>{detail.settings?.aiEnabled ? '在线' : '待机'}</small>
            </div>
          </div>
        </div>

        <div className="ai-service-chat-appbar-actions">
          <div className="ai-service-chat-appbar-stats">
            <span>会话 {detail.conversations.length}</span>
            <span>待人工 {filterCounts.manual}</span>
            <span>高风险 {filterCounts.risk}</span>
          </div>
          <Space wrap>
            <span className={`ai-service-chat-mode-badge ${detail.settings?.aiEnabled ? 'is-on' : ''}`}>
              {detail.settings?.aiEnabled ? 'AI 客服已开启' : 'AI 客服关闭'}
            </span>
            <span className={`ai-service-chat-mode-badge ${detail.settings?.autoReplyEnabled ? 'is-on' : ''}`}>
              {detail.settings?.autoReplyEnabled ? '自动回复开启' : '人工优先'}
            </span>
            {props.canManageWorkspace ? (
              <Button
                type="primary"
                loading={props.busyKey === 'ai-service-sync'}
                onClick={() => void props.onSyncAiServiceConversations()}
              >
                同步真实会话
              </Button>
            ) : null}
          </Space>
        </div>
      </div>

      <div className="ai-service-chat-shell">
        <aside className="ai-service-chat-sidebar">
          <div className="ai-service-chat-sidebar-head">
            <div className="ai-service-chat-sidebar-profile">
              <Avatar size={48} className="ai-service-chat-session-avatar">
                {buildAiServiceInitials(selectedConversation?.storeName ?? detail.title)}
              </Avatar>
              <div className="ai-service-chat-sidebar-profile-main">
                <div className="ai-service-chat-sidebar-title-row">
                  <strong>{selectedConversation?.storeName ?? detail.title}</strong>
                  <span className={`ai-service-chat-online ${detail.settings?.aiEnabled ? 'is-online' : ''}`}>
                    {detail.settings?.aiEnabled ? '在线' : '待机'}
                  </span>
                </div>
                <div className="ai-service-chat-sidebar-subtitle">聊天优先，右侧辅助信息随会话联动</div>
              </div>
            </div>
            <div className="ai-service-chat-sidebar-summary">
              <span>真实会话 {detail.conversations.length}</span>
              <span>已结单 {filterCounts.closed}</span>
            </div>
          </div>
          <div className="ai-service-chat-store-summary">
            <div className="ai-service-chat-store-pill">AI 客服</div>
            <div className="ai-service-chat-store-name">{selectedConversation?.storeName ?? detail.title}</div>
            <div className="ai-service-chat-store-meta">
              <span className={`ai-service-chat-online ${detail.settings?.aiEnabled ? 'is-online' : ''}`}>
                {detail.settings?.aiEnabled ? '在线' : '待机'}
              </span>
              <span>{detail.settings?.autoReplyEnabled ? '自动回复开启' : '人工优先'}</span>
            </div>
          </div>

          <Input
            allowClear
            value={searchText}
            className="ai-service-chat-search"
            placeholder="搜索联系人/订单/备注"
            onChange={(event) => setSearchText(event.target.value)}
          />

          <div className="ai-service-chat-filter-row">
            {filterOptions.map((item) => (
              <button
                type="button"
                key={item.key}
                className={`ai-service-chat-filter-chip ${
                  conversationFilter === item.key ? 'is-active' : ''
                }`}
                onClick={() => setConversationFilter(item.key)}
              >
                <span>{item.label}</span>
                <strong>{item.count}</strong>
              </button>
            ))}
          </div>

          <div className="ai-service-chat-session-toolbar">
            <span>最近会话</span>
            <strong>{filteredConversations.length}</strong>
          </div>

          <div className="ai-service-chat-session-list">
            {filteredConversations.length > 0 ? (
              filteredConversations.map((conversation) => {
                const latestMessage = latestMessageMap.get(conversation.id);
                return (
                  <button
                    type="button"
                    key={conversation.id}
                    className={`ai-service-chat-session-card ${
                      selectedConversation?.id === conversation.id ? 'is-active' : ''
                    }`}
                    onClick={() => setSelectedConversationId(conversation.id)}
                  >
                    <Avatar size={44} className="ai-service-chat-session-avatar">
                      {buildAiServiceInitials(conversation.customerName)}
                    </Avatar>
                    <div className="ai-service-chat-session-body">
                      <div className="ai-service-chat-session-topline">
                        <strong>{conversation.customerName}</strong>
                        <span>{formatAiServiceTimeLabel(conversation.lastMessageAt)}</span>
                      </div>
                      <div className="ai-service-chat-session-topic">{conversation.topic}</div>
                      <div className="ai-service-chat-session-preview">
                        {resolveAiServiceMessagePreview(conversation, latestMessage)}
                      </div>
                      <div className="ai-service-chat-session-tags">
                        {conversation.unreadCount > 0 ? <Tag color="gold">未读 {conversation.unreadCount}</Tag> : null}
                        <Tag color={aiServiceRiskColor(conversation.riskLevel)}>{conversation.riskLevelText}</Tag>
                        <Tag color={aiServiceStatusColor(conversation.conversationStatus)}>
                          {conversation.aiStatusText}
                        </Tag>
                      </div>
                    </div>
                  </button>
                );
              })
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={searchText.trim() ? '没有匹配到会话' : '暂无客服会话'}
              />
            )}
          </div>
        </aside>
        <section className="ai-service-chat-thread">
          {selectedConversation ? (
            <>
              <div className="ai-service-chat-thread-header">
                <div className="ai-service-chat-thread-profile">
                  <Avatar size={52} className="ai-service-chat-session-avatar">
                    {buildAiServiceInitials(selectedConversation.customerName)}
                  </Avatar>
                  <div className="ai-service-chat-thread-meta">
                    <div className="ai-service-chat-thread-name-row">
                      <Typography.Title level={4} style={{ margin: 0 }}>
                        {selectedConversation.customerName}
                      </Typography.Title>
                      <span className="ai-service-chat-thread-status">
                        {selectedConversation.source === '真实会话同步' ? '真实闲鱼会话' : '本地会话'}
                      </span>
                    </div>
                    <div className="ai-service-chat-thread-note">
                      <span>{selectedConversation.topic}</span>
                      <span>{selectedConversation.lastMessageAt}</span>
                      {selectedConversation.orderNo ? <span>订单 {selectedConversation.orderNo}</span> : null}
                    </div>
                    <Space size={[6, 6]} wrap>
                      {selectedConversation.storeName ? <Tag>{selectedConversation.storeName}</Tag> : null}
                      <Tag color={aiServiceRiskColor(selectedConversation.riskLevel)}>
                        {selectedConversation.riskLevelText}
                      </Tag>
                      <Tag color={aiServiceStatusColor(selectedConversation.conversationStatus)}>
                        {selectedConversation.conversationStatusText}
                      </Tag>
                      <Tag>{selectedConversation.boundaryLabel}</Tag>
                      {selectedConversation.tags.map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                    </Space>
                  </div>
                </div>

                <div className="ai-service-chat-thread-actions">
                  {props.canManageWorkspace ? (
                    <>
                      <Button
                        loading={props.busyKey === `ai-reply-${selectedConversation.id}`}
                        onClick={() => void props.onGenerateAiServiceReply(selectedConversation.id)}
                      >
                        AI 回复
                      </Button>
                      <Button
                        loading={props.busyKey === `ai-takeover-${selectedConversation.id}`}
                        onClick={() =>
                          void props.onUpdateAiServiceTakeover(
                            selectedConversation.id,
                            selectedConversation.conversationStatus === 'manual_active'
                              ? 'release'
                              : 'takeover',
                          )
                        }
                      >
                        {selectedConversation.conversationStatus === 'manual_active' ? '释放接管' : '转人工'}
                      </Button>
                    </>
                  ) : (
                    <Tag>只读</Tag>
                  )}
                </div>
              </div>

              <div className="ai-service-chat-thread-surface">
                <div className="ai-service-chat-message-list">
                {selectedMessages.length > 0 ? (
                  selectedMessages.map((message) => {
                    const isCustomerMessage = message.senderType === 'customer';
                    return (
                      <div
                        key={message.id}
                        className={`ai-service-chat-message-row ${
                          isCustomerMessage ? 'is-customer' : 'is-agent'
                        }`}
                      >
                        <div
                          className={`ai-service-chat-message-bubble ${
                            isCustomerMessage ? 'is-customer' : 'is-agent'
                          } ${message.status === 'failed' ? 'is-failed' : ''}`}
                        >
                          <div className="ai-service-chat-message-meta">
                            <strong>{isCustomerMessage ? message.customerName : message.senderTypeText}</strong>
                            <span>{formatAiServiceTimeLabel(message.createdAt)}</span>
                          </div>
                          <div className="ai-service-chat-message-content">{message.content}</div>
                          <div className="ai-service-chat-message-footer">
                            <span>{message.scene}</span>
                            <span>{message.status}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="ai-service-chat-empty-thread">
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="当前会话还没有同步到完整消息，先执行一次“同步真实会话”或等待新消息进入。"
                    />
                  </div>
                )}
                </div>
              </div>

              <div className="ai-service-chat-composer">
                <div className="ai-service-chat-composer-toolbar">
                  <span className="ai-service-chat-composer-label">快捷回复</span>
                </div>
                {quickComposerCards.length > 0 ? (
                  <div className="ai-service-chat-composer-quick">
                    {quickComposerCards.map((item) => (
                      <button
                        type="button"
                        key={item.key}
                        className="ai-service-chat-quick-tag"
                        onClick={() => applyQuickReply(item.content)}
                      >
                        {item.title}
                      </button>
                    ))}
                  </div>
                ) : null}

                <Input.TextArea
                  autoSize={{ minRows: 4, maxRows: 8 }}
                  value={currentDraft}
                  disabled={!props.canManageWorkspace}
                  placeholder="输入人工回复，或先点上方快捷话术带入输入框。"
                  onChange={(event) => {
                    if (!selectedConversation) {
                      return;
                    }
                    setDraftsByConversationId((current) => ({
                      ...current,
                      [selectedConversation.id]: event.target.value,
                    }));
                  }}
                />

                <div className="ai-service-chat-composer-footer">
                  <Typography.Text type="secondary">
                    {selectedConversation.source === '真实会话同步'
                      ? '当前是你的真实闲鱼会话，点击发送后会直接发给买家。'
                      : '当前是本地客服会话。'}
                  </Typography.Text>
                  <Space wrap>
                    <Button
                      type="primary"
                      disabled={!props.canManageWorkspace || !currentDraft.trim()}
                      loading={isSendBusy && props.busyKey === `ai-manual-${selectedConversation.id}`}
                      onClick={() => handleSendManualReply(false)}
                    >
                      发送
                    </Button>
                    <Button
                      disabled={!props.canManageWorkspace || !currentDraft.trim()}
                      loading={isSendBusy && props.busyKey === `ai-manual-close-${selectedConversation.id}`}
                      onClick={() => handleSendManualReply(true)}
                    >
                      回复并结单
                    </Button>
                  </Space>
                </div>
              </div>
            </>
          ) : (
            <div className="ai-service-chat-empty-thread">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="先从左侧选择一个会话，或点击上方“同步真实会话”拉取最新买家消息。"
              />
            </div>
          )}
        </section>

        <aside className="ai-service-chat-sidepanel">
          <div className="ai-service-chat-tab-row">
            {sidebarTabs.map((item) => (
              <button
                type="button"
                key={item.key}
                className={`ai-service-chat-tab ${sidebarTab === item.key ? 'is-active' : ''}`}
                onClick={() => setSidebarTab(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="ai-service-chat-sidecontent">
            {selectedConversation ? (
              <>
                {sidebarTab === 'service' ? (
                  <>
                    <div className="ai-service-side-section">
                      <div className="ai-service-side-section-title">客服开关</div>
                      <Space wrap>
                        <Tag color={detail.settings?.aiEnabled ? 'success' : 'default'}>
                          AI 客服{detail.settings?.aiEnabled ? '已开启' : '已关闭'}
                        </Tag>
                        <Tag color={detail.settings?.autoReplyEnabled ? 'processing' : 'default'}>
                          自动回复{detail.settings?.autoReplyEnabled ? '已开启' : '已关闭'}
                        </Tag>
                        <Tag color={detail.settings?.highRiskManualOnly ? 'warning' : 'default'}>
                          高风险{detail.settings?.highRiskManualOnly ? '仅人工' : '可自动'}
                        </Tag>
                      </Space>
                      {props.canManageWorkspace && detail.settings ? (
                        <Space wrap>
                          <Button
                            size="small"
                            loading={props.busyKey === 'ai-settings'}
                            onClick={() =>
                              void props.onUpdateAiServiceSettings({
                                aiEnabled: !detail.settings?.aiEnabled,
                              })
                            }
                          >
                            {detail.settings.aiEnabled ? '关闭 AI 客服' : '开启 AI 客服'}
                          </Button>
                          <Button
                            size="small"
                            loading={props.busyKey === 'ai-settings'}
                            onClick={() =>
                              void props.onUpdateAiServiceSettings({
                                autoReplyEnabled: !detail.settings?.autoReplyEnabled,
                              })
                            }
                          >
                            {detail.settings.autoReplyEnabled ? '关闭自动回复' : '开启自动回复'}
                          </Button>
                        </Space>
                      ) : null}
                    </div>

                    <div className="ai-service-side-section">
                      <div className="ai-service-side-section-title">会话摘要</div>
                      <Descriptions size="small" column={1} bordered>
                        <Descriptions.Item label="买家">{selectedConversation.customerName}</Descriptions.Item>
                        <Descriptions.Item label="店铺">
                          {selectedConversation.storeName ?? '-'}
                        </Descriptions.Item>
                        <Descriptions.Item label="最新意图">
                          {selectedConversation.latestUserIntent}
                        </Descriptions.Item>
                        <Descriptions.Item label="当前 AI 状态">
                          {selectedConversation.aiStatusText}
                        </Descriptions.Item>
                        <Descriptions.Item label="模型密钥">
                          {detail.settings?.modelKeyMasked ?? '未配置'}
                        </Descriptions.Item>
                      </Descriptions>
                    </div>

                    <div className="ai-service-side-section">
                      <div className="ai-service-side-section-title">人工接管记录</div>
                      {selectedTakeovers.length > 0 ? (
                        <div className="ai-service-side-timeline">
                          {selectedTakeovers.map((item: AiServiceTakeover) => (
                            <div key={item.id} className="ai-service-side-timeline-item">
                              <strong>{item.actionType === 'takeover' ? '接管' : '释放'}</strong>
                              <span>{item.operatorName}</span>
                              <p>{item.note || '无备注'}</p>
                              <small>{item.createdAt}</small>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无人工接管记录" />
                      )}
                    </div>
                  </>
                ) : null}
                {sidebarTab === 'quick-reply' ? (
                  <>
                    <div className="ai-service-side-section">
                      <div className="ai-service-side-section-title">回复模板</div>
                      <div className="ai-service-side-card-list">
                        {detail.replyTemplates.map((item: AiServiceReplyTemplate) => (
                          <div key={item.id} className="ai-service-side-card">
                            <div className="ai-service-side-card-head">
                              <strong>{item.title}</strong>
                              <Tag color={item.enabled ? 'success' : 'default'}>
                                {item.enabled ? '启用' : '停用'}
                              </Tag>
                            </div>
                            <div className="ai-service-side-card-subtitle">{item.scene}</div>
                            <p>{item.templateContent}</p>
                            <Space wrap>
                              <Button size="small" onClick={() => applyQuickReply(item.templateContent)}>
                                带入输入框
                              </Button>
                              {props.canManageWorkspace ? (
                                <Button
                                  size="small"
                                  loading={props.busyKey === `ai-template-${item.id}`}
                                  onClick={() => void props.onToggleAiReplyTemplate(item.id, !item.enabled)}
                                >
                                  {item.enabled ? '停用' : '启用'}
                                </Button>
                              ) : null}
                            </Space>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="ai-service-side-section">
                      <div className="ai-service-side-section-title">知识库</div>
                      <div className="ai-service-side-card-list">
                        {detail.knowledgeItems.map((item: AiServiceKnowledgeItem) => (
                          <div key={item.id} className="ai-service-side-card">
                            <div className="ai-service-side-card-head">
                              <strong>{item.title}</strong>
                              <Tag color={aiServiceRiskColor(item.riskLevel)}>{item.riskLevelText}</Tag>
                            </div>
                            <div className="ai-service-side-card-subtitle">{item.keywordsText}</div>
                            <p>{item.answerText}</p>
                            <Space wrap>
                              <Button size="small" onClick={() => applyQuickReply(item.answerText)}>
                                带入输入框
                              </Button>
                              {props.canManageWorkspace ? (
                                <Button
                                  size="small"
                                  loading={props.busyKey === `ai-knowledge-${item.id}`}
                                  onClick={() => void props.onToggleAiKnowledgeItem(item.id, !item.enabled)}
                                >
                                  {item.enabled ? '停用' : '启用'}
                                </Button>
                              ) : null}
                            </Space>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : null}

                {sidebarTab === 'product' ? (
                  <div className="ai-service-side-section">
                    <div className="ai-service-side-section-title">商品与会话标签</div>
                    <Descriptions size="small" column={1} bordered>
                      <Descriptions.Item label="会话主题">{selectedConversation.topic}</Descriptions.Item>
                      <Descriptions.Item label="边界标签">
                        {selectedConversation.boundaryLabel}
                      </Descriptions.Item>
                      <Descriptions.Item label="来源">{selectedConversation.source}</Descriptions.Item>
                      <Descriptions.Item label="标签">
                        {selectedConversation.tags.length > 0 ? selectedConversation.tags.join(' / ') : '-'}
                      </Descriptions.Item>
                    </Descriptions>
                  </div>
                ) : null}

                {sidebarTab === 'order' ? (
                  <div className="ai-service-side-section">
                    <div className="ai-service-side-section-title">订单与售后</div>
                    <Descriptions size="small" column={1} bordered>
                      <Descriptions.Item label="订单号">{selectedConversation.orderNo ?? '-'}</Descriptions.Item>
                      <Descriptions.Item label="售后单号">{selectedConversation.caseNo ?? '-'}</Descriptions.Item>
                      <Descriptions.Item label="最近消息时间">
                        {selectedConversation.lastMessageAt}
                      </Descriptions.Item>
                      <Descriptions.Item label="会话状态">
                        {selectedConversation.conversationStatusText}
                      </Descriptions.Item>
                      <Descriptions.Item label="最新意图">
                        {selectedConversation.latestUserIntent}
                      </Descriptions.Item>
                    </Descriptions>
                  </div>
                ) : null}

                {sidebarTab === 'customer' ? (
                  <div className="ai-service-side-section">
                    <div className="ai-service-side-section-title">客户画像</div>
                    <Descriptions size="small" column={1} bordered>
                      <Descriptions.Item label="客户名">{selectedConversation.customerName}</Descriptions.Item>
                      <Descriptions.Item label="渠道">{selectedConversation.channel}</Descriptions.Item>
                      <Descriptions.Item label="会话编号">{selectedConversation.sessionNo}</Descriptions.Item>
                      <Descriptions.Item label="未读消息">{selectedConversation.unreadCount}</Descriptions.Item>
                      <Descriptions.Item label="指派客服">
                        {selectedConversation.assignedUserName ?? '未指派'}
                      </Descriptions.Item>
                    </Descriptions>
                  </div>
                ) : null}
              </>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可展示的会话详情" />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

void AiServiceChatPanel;

function amountText(value: number) {
  return value.toFixed(2);
}

function fileSizeText(value: number) {
  if (value <= 0) {
    return '0 B';
  }
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(2)} KB`;
  }
  return `${value} B`;
}

function renderPrimitive(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  if (typeof value === 'boolean') {
    return value ? '是' : '否';
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join('、') : '-';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function makeColumns(
  rows: Array<Record<string, unknown>>,
): NonNullable<TableProps<Record<string, unknown>>['columns']> {
  const keys = Array.from(
    new Set(
      rows.flatMap((row) => Object.keys(row)).filter((key) => !['id', 'kind'].includes(key)),
    ),
  ).slice(0, 10);

  return keys.map((key) => ({
    title: key,
    dataIndex: key,
    key,
    render: (value: unknown) => renderPrimitive(value),
  }));
}

function DataPanel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="module-panel">
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>
      {children}
    </div>
  );
}

type AiServiceConversation = AiServiceDetailResponse['conversations'][number];
type AiServiceMessage = AiServiceDetailResponse['recentMessages'][number];
type AiServiceTakeover = AiServiceDetailResponse['takeovers'][number];
type AiServiceKnowledgeItem = AiServiceDetailResponse['knowledgeItems'][number];
type AiServiceReplyTemplate = AiServiceDetailResponse['replyTemplates'][number];
type AiServiceSidebarTab = 'service' | 'quick-reply' | 'product' | 'order' | 'customer';
type AiServiceConversationFilter = 'all' | 'manual' | 'risk' | 'closed';

function aiServiceRiskColor(riskLevel: string) {
  if (riskLevel === 'high') {
    return 'error';
  }
  if (riskLevel === 'medium') {
    return 'warning';
  }
  return 'success';
}

function aiServiceStatusColor(status: string) {
  if (status === 'manual_active') {
    return 'processing';
  }
  if (status === 'resolved') {
    return 'success';
  }
  if (status === 'closed') {
    return 'default';
  }
  return 'gold';
}

function formatAiServiceTimeLabel(value: string | null | undefined) {
  const normalized = String(value ?? '').trim().replace('T', ' ');
  if (!normalized) {
    return '--';
  }
  if (normalized.length >= 16) {
    return normalized.slice(5, 16);
  }
  return normalized;
}

function buildAiServiceInitials(name: string | null | undefined) {
  const normalized = String(name ?? '').trim();
  if (!normalized) {
    return '客';
  }
  return normalized.slice(0, 2).toUpperCase();
}

function resolveAiServiceMessagePreview(
  conversation: AiServiceConversation,
  latestMessage: AiServiceMessage | undefined,
) {
  if (latestMessage?.content?.trim()) {
    return latestMessage.content.trim();
  }
  if (conversation.latestUserIntent?.trim()) {
    return conversation.latestUserIntent.trim();
  }
  return conversation.topic;
}

interface WorkspaceBusinessSectionProps {
  detail: WorkspaceBusinessDetailResponse;
  busyKey: string | null;
  canManageWorkspace: boolean;
  canManageUsers: boolean;
  canManageSecureSettings: boolean;
  canApproveWithdrawals: boolean;
  storeOptions: Array<{ label: string; value: number }>;
  onToggleDirectChargeSupplier: (supplierId: number) => Promise<void>;
  onRotateDirectChargeSupplierToken: (supplierId: number) => Promise<void>;
  onDispatchDirectChargeJob: (jobId: number) => Promise<void>;
  onRetryDirectChargeJob: (jobId: number) => Promise<void>;
  onMarkDirectChargeJobManualReview: (jobId: number) => Promise<void>;
  onToggleSupplySourceSystem: (systemId: number) => Promise<void>;
  onRotateSupplySourceSystemToken: (systemId: number) => Promise<void>;
  onRunSupplySourceSync: (
    systemId: number,
    syncType: DistributionSourceDetailResponse['sourceSyncRuns'][number]['syncType'],
  ) => Promise<void>;
  onRetrySupplySourceSyncRun: (runId: number) => Promise<void>;
  onDispatchSupplySourceOrder: (sourceOrderId: number) => Promise<void>;
  onRetrySupplySourceOrder: (sourceOrderId: number) => Promise<void>;
  onMarkSupplySourceOrderManualReview: (sourceOrderId: number) => Promise<void>;
  onToggleDeliveryItem: (id: number) => Promise<void>;
  onImportCardBatch: (cardTypeId: number) => Promise<void>;
  onToggleCardInventorySample: (cardTypeId: number) => Promise<void>;
  onRunCardDeliveryJob: (jobId: number) => Promise<void>;
  onToggleComboStatus: (id: number) => Promise<void>;
  onToggleTemplateRandom: (id: number) => Promise<void>;
  onResendCardOutbound: (outboundRecordId: number) => Promise<void>;
  onRecycleCardOutbound: (outboundRecordId: number, action: 'recycle' | 'revoke') => Promise<void>;
  onRestoreCardType: (id: number) => Promise<void>;
  onUpdateWithdrawalStatus: (
    id: number,
    status: FundWithdrawalsDetailResponse['rows'][number]['status'],
  ) => Promise<void>;
  onCreateWithdrawal: (input: {
    amount: number;
    storeId?: number;
    method: string;
    receivingAccount: string;
  }) => Promise<void>;
  onUpdateReconciliationStatus: (
    id: number,
    status: 'matched' | 'anomaly' | 'reviewed',
  ) => Promise<void>;
  onGenerateAiServiceReply: (conversationId: number) => Promise<void>;
  onUpdateAiServiceTakeover: (
    conversationId: number,
    action: 'takeover' | 'release',
  ) => Promise<void>;
  onSendAiServiceManualReply: (
    conversationId: number,
    content: string,
    closeConversation: boolean,
  ) => Promise<void>;
  onUpdateAiServiceSettings: (input: {
    aiEnabled?: boolean;
    autoReplyEnabled?: boolean;
    faqEnabled?: boolean;
    orderQueryEnabled?: boolean;
    afterSaleSuggestionEnabled?: boolean;
    highRiskManualOnly?: boolean;
    boundaryNote?: string;
    sensitiveWordsText?: string;
  }) => Promise<void>;
  onToggleAiKnowledgeItem: (knowledgeItemId: number, enabled: boolean) => Promise<void>;
  onToggleAiReplyTemplate: (templateId: number, enabled: boolean) => Promise<void>;
  onSyncAiServiceConversations: () => Promise<void>;
  onSyncAiBargainSessions: () => Promise<void>;
  onEvaluateAiBargainSession: (sessionId: number) => Promise<void>;
  onUpdateAiBargainTakeover: (
    sessionId: number,
    action: 'takeover' | 'release',
    note: string,
  ) => Promise<void>;
  onSendAiBargainManualDecision: (
    sessionId: number,
    input: {
      content: string;
      action: 'counter_offer' | 'accept' | 'reject';
      offerPrice?: number;
    },
  ) => Promise<void>;
  onUpdateAiBargainSettings: (input: {
    aiEnabled?: boolean;
    autoBargainEnabled?: boolean;
    highRiskManualOnly?: boolean;
    allowAutoAccept?: boolean;
    boundaryNote?: string;
    sensitiveWordsText?: string;
    blacklistNotice?: string;
  }) => Promise<void>;
  onUpdateAiBargainStrategy: (
    strategyId: number,
    input: {
      minPrice: number;
      targetPrice: number;
      stepPrice: number;
      maxRounds: number;
      enabled?: boolean;
      riskTagsText?: string;
    },
  ) => Promise<void>;
  onToggleAiBargainTemplate: (templateId: number, enabled: boolean) => Promise<void>;
  onToggleAiBargainBlacklist: (blacklistId: number, enabled: boolean) => Promise<void>;
  onCreateSystemUser: (input: {
    username: string;
    displayName: string;
    password: string;
    role: SystemUserRole;
  }) => Promise<void>;
  onUpdateSystemUserRole: (userId: number, role: SystemUserRole) => Promise<void>;
  onUpdateSystemUserStatus: (userId: number, status: 'active' | 'disabled') => Promise<void>;
  onUpdateSecureSetting: (key: string, description: string, value: string) => Promise<void>;
  onUpdateSystemAlertStatus: (alertId: number, status: 'acknowledged' | 'resolved') => Promise<void>;
  onRunSystemBackup: () => Promise<void>;
  onRunSystemLogArchive: () => Promise<void>;
  onRunSystemRecoveryDrill: () => Promise<void>;
}

function renderGenericContent(detail: WorkspaceBusinessDetailResponse) {
  const entries = Object.entries(detail as unknown as Record<string, unknown>).filter(
    ([key]) => !['kind', 'title', 'description', 'metrics'].includes(key),
  );

  if (entries.length === 0) {
    return <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {entries.map(([key, value]) => {
        if (Array.isArray(value)) {
          if (value.length === 0) {
            return (
              <DataPanel key={key} title={key}>
                <Empty description="暂无数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              </DataPanel>
            );
          }
          if (typeof value[0] === 'object' && value[0] !== null) {
            const rows = value as Array<Record<string, unknown>>;
            return (
              <DataPanel key={key} title={key}>
                <Table rowKey={(row) => String(row.id ?? row.rowKey ?? JSON.stringify(row))} pagination={false} size="small" scroll={{ x: 1200 }} dataSource={rows} columns={makeColumns(rows)} />
              </DataPanel>
            );
          }
          return (
            <DataPanel key={key} title={key}>
              <Space wrap>
                {value.map((item) => (
                  <Tag key={String(item)}>{renderPrimitive(item)}</Tag>
                ))}
              </Space>
            </DataPanel>
          );
        }

        if (value && typeof value === 'object') {
          return (
            <DataPanel key={key} title={key}>
              <Descriptions size="small" bordered column={1}>
                {Object.entries(value as Record<string, unknown>).map(([innerKey, innerValue]) => (
                  <Descriptions.Item key={innerKey} label={innerKey}>
                    {renderPrimitive(innerValue)}
                  </Descriptions.Item>
                ))}
              </Descriptions>
            </DataPanel>
          );
        }

        return (
          <DataPanel key={key} title={key}>
            <Typography.Text>{renderPrimitive(value)}</Typography.Text>
          </DataPanel>
        );
      })}
    </Space>
  );
}

function renderDistributionSource(
  detail: DistributionSourceDetailResponse,
  props: WorkspaceBusinessSectionProps,
) {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <DataPanel title="直充供应商">
        <Table
          rowKey="id"
          pagination={false}
          size="small"
          scroll={{ x: 1280 }}
          dataSource={detail.suppliers}
          columns={[
            { title: '供应商', dataIndex: 'supplierName' },
            { title: '标识', dataIndex: 'supplierKey' },
            { title: '接口地址', dataIndex: 'endpointUrl' },
            { title: '余额', render: (_value, row) => `¥${amountText(row.balance)}` },
            { title: '成功率', render: (_value, row) => `${row.successRate}%` },
            { title: '异常数', dataIndex: 'anomalyCount' },
            {
              title: '状态',
              render: (_value, row) => (
                <Tag color={row.supplierStatus === 'online' ? 'success' : row.supplierStatus === 'warning' ? 'warning' : 'default'}>
                  {row.supplierStatus}
                </Tag>
              ),
            },
            {
              title: '操作',
              render: (_value, row) =>
                props.canManageWorkspace ? (
                  <Space wrap size={4}>
                    <Button size="small" loading={props.busyKey === `supplier-${row.id}`} onClick={() => void props.onToggleDirectChargeSupplier(row.id)}>
                      {row.enabled ? '停用' : '启用'}
                    </Button>
                    <Button size="small" loading={props.busyKey === `supplier-token-${row.id}`} onClick={() => void props.onRotateDirectChargeSupplierToken(row.id)}>
                      轮换令牌
                    </Button>
                  </Space>
                ) : (
                  <Tag>只读</Tag>
                ),
            },
          ]}
        />
      </DataPanel>

      <DataPanel title="商品映射">
        <Table rowKey="id" pagination={false} size="small" scroll={{ x: 1100 }} dataSource={detail.items} columns={makeColumns(detail.items as Array<Record<string, unknown>>)} />
      </DataPanel>

      <DataPanel title="货源系统">
        <Table
          rowKey="id"
          pagination={false}
          size="small"
          scroll={{ x: 1500 }}
          dataSource={detail.sourceSystems}
          columns={[
            { title: '系统', dataIndex: 'systemName' },
            { title: '标识', dataIndex: 'systemKey' },
            { title: '同步模式', dataIndex: 'syncMode' },
            { title: '映射数', dataIndex: 'mappingCount' },
            { title: '异常数', dataIndex: 'anomalyCount' },
            { title: '商品同步', dataIndex: 'lastProductSyncAt', render: (value) => value ?? '-' },
            { title: '库存同步', dataIndex: 'lastInventorySyncAt', render: (value) => value ?? '-' },
            { title: '价格同步', dataIndex: 'lastPriceSyncAt', render: (value) => value ?? '-' },
            {
              title: '状态',
              render: (_value, row) => (
                <Tag color={row.systemStatus === 'online' ? 'success' : row.systemStatus === 'warning' ? 'warning' : 'default'}>
                  {row.systemStatus}
                </Tag>
              ),
            },
            {
              title: '操作',
              render: (_value, row) =>
                props.canManageWorkspace ? (
                  <Space wrap size={4}>
                    <Button size="small" loading={props.busyKey === `source-system-${row.id}`} onClick={() => void props.onToggleSupplySourceSystem(row.id)}>
                      {row.enabled ? '停用' : '启用'}
                    </Button>
                    <Button size="small" loading={props.busyKey === `source-system-token-${row.id}`} onClick={() => void props.onRotateSupplySourceSystemToken(row.id)}>
                      轮换令牌
                    </Button>
                    <Button size="small" loading={props.busyKey === `source-sync-${row.id}-product`} onClick={() => void props.onRunSupplySourceSync(row.id, 'product')}>
                      商品同步
                    </Button>
                    <Button size="small" loading={props.busyKey === `source-sync-${row.id}-inventory`} onClick={() => void props.onRunSupplySourceSync(row.id, 'inventory')}>
                      库存同步
                    </Button>
                    <Button size="small" loading={props.busyKey === `source-sync-${row.id}-price`} onClick={() => void props.onRunSupplySourceSync(row.id, 'price')}>
                      价格同步
                    </Button>
                  </Space>
                ) : (
                  <Tag>只读</Tag>
                ),
            },
          ]}
        />
      </DataPanel>

      <DataPanel title="货源商品映射">
        <Table rowKey="id" pagination={false} size="small" scroll={{ x: 1280 }} dataSource={detail.sourceProducts} columns={makeColumns(detail.sourceProducts as Array<Record<string, unknown>>)} />
      </DataPanel>

      <DataPanel title="同步记录">
        <Table
          rowKey="id"
          pagination={false}
          size="small"
          scroll={{ x: 1080 }}
          dataSource={detail.sourceSyncRuns}
          columns={[
            { title: '系统', dataIndex: 'systemName' },
            { title: '同步类型', dataIndex: 'syncType' },
            { title: '执行方式', dataIndex: 'runMode' },
            { title: '状态', dataIndex: 'runStatus' },
            { title: '结果', render: (_value, row) => `${row.successCount}/${row.totalCount}` },
            { title: '详情', dataIndex: 'detail' },
            { title: '开始时间', dataIndex: 'createdAt' },
            { title: '结束时间', dataIndex: 'finishedAt' },
            {
              title: '操作',
              render: (_value, row) =>
                props.canManageWorkspace ? (
                  <Button size="small" loading={props.busyKey === `source-sync-retry-${row.id}`} onClick={() => void props.onRetrySupplySourceSyncRun(row.id)}>
                    重试
                  </Button>
                ) : (
                  <Tag>只读</Tag>
                ),
            },
          ]}
        />
      </DataPanel>
    </Space>
  );
}

function renderAiService(detail: AiServiceDetailResponse, props: WorkspaceBusinessSectionProps) {
  return <AiServiceChatWorkspacePanel detail={detail} props={props} />;
}

function renderDistributionSupply(
  detail: DistributionSupplyDetailResponse,
  props: WorkspaceBusinessSectionProps,
) {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <DataPanel title="状态分布">
        <Space wrap>
          {detail.statuses.map((item) => (
            <Tag key={item.label}>{`${item.label}: ${item.count}`}</Tag>
          ))}
        </Space>
      </DataPanel>

      <DataPanel title="直充任务">
        <Table
          rowKey="id"
          pagination={false}
          size="small"
          scroll={{ x: 1380 }}
          dataSource={detail.jobs}
          columns={[
            { title: '订单号', dataIndex: 'orderNo' },
            { title: '商品', dataIndex: 'productTitle' },
            { title: '供应商', dataIndex: 'supplierName' },
            { title: '任务号', dataIndex: 'taskNo' },
            { title: '目标账号', dataIndex: 'targetAccount' },
            { title: '状态', dataIndex: 'taskStatus' },
            { title: '回调状态', dataIndex: 'callbackStatus' },
            { title: '重试', render: (_value, row) => `${row.retryCount}/${row.maxRetry}` },
            { title: '结果', dataIndex: 'resultDetail', render: (value) => value ?? '-' },
            {
              title: '操作',
              render: (_value, row) =>
                props.canManageWorkspace ? (
                  <Space wrap size={4}>
                    <Button size="small" loading={props.busyKey === `direct-charge-dispatch-${row.id}`} onClick={() => void props.onDispatchDirectChargeJob(row.id)}>
                      下发
                    </Button>
                    <Button size="small" loading={props.busyKey === `direct-charge-retry-${row.id}`} onClick={() => void props.onRetryDirectChargeJob(row.id)}>
                      重试
                    </Button>
                    <Button size="small" loading={props.busyKey === `direct-charge-manual-${row.id}`} onClick={() => void props.onMarkDirectChargeJobManualReview(row.id)}>
                      转人工
                    </Button>
                  </Space>
                ) : (
                  <Tag>只读</Tag>
                ),
            },
          ]}
        />
      </DataPanel>

      <DataPanel title="直充回调">
        <Table rowKey="id" pagination={false} size="small" scroll={{ x: 1200 }} dataSource={detail.callbacks} columns={makeColumns(detail.callbacks as Array<Record<string, unknown>>)} />
      </DataPanel>

      <DataPanel title="直充对账">
        <Table rowKey="id" pagination={false} size="small" scroll={{ x: 1200 }} dataSource={detail.reconciliations} columns={makeColumns(detail.reconciliations as Array<Record<string, unknown>>)} />
      </DataPanel>

      <DataPanel title="货源订单">
        <Table
          rowKey="id"
          pagination={false}
          size="small"
          scroll={{ x: 1380 }}
          dataSource={detail.sourceOrders}
          columns={[
            { title: '订单号', dataIndex: 'orderNo' },
            { title: '商品', dataIndex: 'productName', render: (value) => value ?? '-' },
            { title: '系统', dataIndex: 'systemName' },
            { title: '任务号', dataIndex: 'taskNo' },
            { title: '货源单号', dataIndex: 'sourceOrderNo', render: (value) => value ?? '-' },
            { title: '状态', dataIndex: 'orderStatus' },
            { title: '验签', dataIndex: 'verificationStatus' },
            { title: '重试', render: (_value, row) => `${row.retryCount}/${row.maxRetry}` },
            { title: '结果', dataIndex: 'resultDetail', render: (value) => value ?? '-' },
            {
              title: '操作',
              render: (_value, row) =>
                props.canManageWorkspace ? (
                  <Space wrap size={4}>
                    <Button size="small" loading={props.busyKey === `source-order-dispatch-${row.id}`} onClick={() => void props.onDispatchSupplySourceOrder(row.id)}>
                      推单
                    </Button>
                    <Button size="small" loading={props.busyKey === `source-order-retry-${row.id}`} onClick={() => void props.onRetrySupplySourceOrder(row.id)}>
                      重试
                    </Button>
                    <Button size="small" loading={props.busyKey === `source-order-manual-${row.id}`} onClick={() => void props.onMarkSupplySourceOrderManualReview(row.id)}>
                      转人工
                    </Button>
                  </Space>
                ) : (
                  <Tag>只读</Tag>
                ),
            },
          ]}
        />
      </DataPanel>

      <DataPanel title="发货回调">
        <Table rowKey="id" pagination={false} size="small" scroll={{ x: 1180 }} dataSource={detail.sourceCallbacks} columns={makeColumns(detail.sourceCallbacks as Array<Record<string, unknown>>)} />
      </DataPanel>

      <DataPanel title="退款通知">
        <Table rowKey="id" pagination={false} size="small" scroll={{ x: 1180 }} dataSource={detail.sourceRefundNotices} columns={makeColumns(detail.sourceRefundNotices as Array<Record<string, unknown>>)} />
      </DataPanel>

      <DataPanel title="货源对账">
        <Table rowKey="id" pagination={false} size="small" scroll={{ x: 1180 }} dataSource={detail.sourceReconciliations} columns={makeColumns(detail.sourceReconciliations as Array<Record<string, unknown>>)} />
      </DataPanel>
    </Space>
  );
}

function renderSystemMonitoring(
  detail: SystemMonitoringDetailResponse,
  props: WorkspaceBusinessSectionProps,
) {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <DataPanel title="运行摘要">
        <Descriptions size="small" bordered column={2}>
          <Descriptions.Item label="接口状态">{detail.health.apiStatus}</Descriptions.Item>
          <Descriptions.Item label="数据库体积">
            {fileSizeText(detail.health.databaseSizeBytes)}
          </Descriptions.Item>
          <Descriptions.Item label="数据库路径">{detail.health.databasePath}</Descriptions.Item>
          <Descriptions.Item label="最近备份">{detail.health.latestBackupAt ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="备份目录">{detail.health.backupRootDir}</Descriptions.Item>
          <Descriptions.Item label="日志归档目录">{detail.health.logArchiveRootDir}</Descriptions.Item>
          <Descriptions.Item label="恢复目录">{detail.health.recoveryRootDir}</Descriptions.Item>
          <Descriptions.Item label="最近演练">{detail.health.latestRecoveryAt ?? '-'}</Descriptions.Item>
        </Descriptions>
      </DataPanel>

      <DataPanel title="运维动作">
        <Space wrap>
          <Button
            type="primary"
            disabled={!props.canManageWorkspace}
            loading={props.busyKey === 'system-backup'}
            onClick={() => void props.onRunSystemBackup()}
          >
            执行备份
          </Button>
          <Button
            disabled={!props.canManageWorkspace}
            loading={props.busyKey === 'system-log-archive'}
            onClick={() => void props.onRunSystemLogArchive()}
          >
            归档日志
          </Button>
          <Button
            disabled={!props.canManageWorkspace}
            loading={props.busyKey === 'system-recovery-drill'}
            onClick={() => void props.onRunSystemRecoveryDrill()}
          >
            恢复演练
          </Button>
        </Space>
      </DataPanel>

      <DataPanel title="告警列表">
        <Table
          rowKey="id"
          pagination={false}
          size="small"
          scroll={{ x: 1280 }}
          dataSource={detail.alerts}
          columns={[
            { title: '类型', dataIndex: 'alertTypeText' },
            {
              title: '级别',
              render: (_value, row) => (
                <Tag color={row.severity === 'critical' ? 'error' : 'warning'}>{row.severity}</Tag>
              ),
            },
            {
              title: '状态',
              render: (_value, row) => (
                <Tag
                  color={
                    row.status === 'open'
                      ? 'error'
                      : row.status === 'acknowledged'
                        ? 'processing'
                        : 'success'
                  }
                >
                  {row.status}
                </Tag>
              ),
            },
            { title: '触发数', dataIndex: 'sourceCount' },
            { title: '标题', dataIndex: 'title' },
            { title: '详情', dataIndex: 'detail' },
            { title: '最近触发', dataIndex: 'lastTriggeredAt' },
            {
              title: '操作',
              render: (_value, row) =>
                props.canManageWorkspace ? (
                  <Space wrap size={4}>
                    <Button
                      size="small"
                      disabled={row.status === 'acknowledged'}
                      loading={props.busyKey === `system-alert-${row.id}-acknowledged`}
                      onClick={() => void props.onUpdateSystemAlertStatus(row.id, 'acknowledged')}
                    >
                      确认
                    </Button>
                    <Button
                      size="small"
                      disabled={row.status === 'resolved'}
                      loading={props.busyKey === `system-alert-${row.id}-resolved`}
                      onClick={() => void props.onUpdateSystemAlertStatus(row.id, 'resolved')}
                    >
                      处理完成
                    </Button>
                  </Space>
                ) : (
                  <Tag>只读</Tag>
                ),
            },
          ]}
        />
      </DataPanel>

      <DataPanel title="任务监控">
        <Table
          rowKey="groupKey"
          pagination={false}
          size="small"
          scroll={{ x: 980 }}
          dataSource={detail.jobMonitors}
          columns={[
            { title: '任务组', dataIndex: 'groupLabel' },
            { title: '待处理', dataIndex: 'pendingCount' },
            { title: '失败', dataIndex: 'failedCount' },
            { title: '人工介入', dataIndex: 'manualCount' },
            { title: '最近更新时间', dataIndex: 'latestUpdatedAt', render: (value) => value ?? '-' },
            { title: '说明', dataIndex: 'note' },
          ]}
        />
      </DataPanel>

      <DataPanel title="备份记录">
        <Table
          rowKey="id"
          pagination={false}
          size="small"
          scroll={{ x: 1320 }}
          dataSource={detail.backups}
          columns={[
            { title: '备份编号', dataIndex: 'backupNo' },
            { title: '类型', dataIndex: 'backupType' },
            { title: '状态', dataIndex: 'runStatus' },
            { title: '文件', dataIndex: 'fileName', render: (value) => value || '-' },
            { title: '大小', render: (_value, row) => fileSizeText(row.fileSize) },
            { title: '开始时间', dataIndex: 'startedAt' },
            { title: '完成时间', dataIndex: 'finishedAt', render: (value) => value ?? '-' },
            { title: '说明', dataIndex: 'detail' },
          ]}
        />
      </DataPanel>

      <DataPanel title="日志归档">
        <Table
          rowKey="id"
          pagination={false}
          size="small"
          scroll={{ x: 1220 }}
          dataSource={detail.logArchives}
          columns={[
            { title: '归档编号', dataIndex: 'archiveNo' },
            { title: '区间开始', dataIndex: 'periodStart' },
            { title: '区间结束', dataIndex: 'periodEnd' },
            { title: '日志数', dataIndex: 'logCount' },
            { title: '状态', dataIndex: 'archiveStatus' },
            { title: '文件', dataIndex: 'fileName' },
            { title: '创建时间', dataIndex: 'createdAt' },
          ]}
        />
      </DataPanel>

      <DataPanel title="恢复演练">
        <Table
          rowKey="id"
          pagination={false}
          size="small"
          scroll={{ x: 1220 }}
          dataSource={detail.recoveryDrills}
          columns={[
            { title: '演练编号', dataIndex: 'drillNo' },
            { title: '备份编号', dataIndex: 'backupNo', render: (value) => value ?? '-' },
            { title: '状态', dataIndex: 'drillStatus' },
            { title: '耗时', render: (_value, row) => `${row.durationSeconds} 秒` },
            { title: '开始时间', dataIndex: 'startedAt' },
            { title: '完成时间', dataIndex: 'finishedAt', render: (value) => value ?? '-' },
            { title: '说明', dataIndex: 'detail' },
          ]}
        />
      </DataPanel>

      {detail.notes.length > 0 ? (
        <DataPanel title="运维说明">
          <Space direction="vertical" size={8}>
            {detail.notes.map((item) => (
              <Typography.Text key={item}>{item}</Typography.Text>
            ))}
          </Space>
        </DataPanel>
      ) : null}
    </Space>
  );
}

function renderFundAccounts(detail: FundAccountsDetailResponse, props: WorkspaceBusinessSectionProps) {
  const reconciliationColumns = makeColumns(
    detail.reconciliations as Array<Record<string, unknown>>,
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {detail.account ? (
        <DataPanel title="资金账户">
          <Descriptions size="small" bordered column={2}>
            <Descriptions.Item label="账户名称">{detail.account.accountName}</Descriptions.Item>
            <Descriptions.Item label="状态">{detail.account.status}</Descriptions.Item>
            <Descriptions.Item label="可用余额">{`¥${amountText(detail.account.availableBalance)}`}</Descriptions.Item>
            <Descriptions.Item label="待提现">{`¥${amountText(detail.account.pendingWithdrawal)}`}</Descriptions.Item>
            <Descriptions.Item label="冻结余额">{`¥${amountText(detail.account.frozenBalance)}`}</Descriptions.Item>
            <Descriptions.Item label="更新时间">{detail.account.updatedAt}</Descriptions.Item>
          </Descriptions>
        </DataPanel>
      ) : null}

      <DataPanel title="结算记录">
        <Table rowKey="id" pagination={false} size="small" scroll={{ x: 1200 }} dataSource={detail.settlements} columns={makeColumns(detail.settlements as Array<Record<string, unknown>>)} />
      </DataPanel>

      <DataPanel title="退款记录">
        <Table rowKey="id" pagination={false} size="small" scroll={{ x: 1200 }} dataSource={detail.refunds} columns={makeColumns(detail.refunds as Array<Record<string, unknown>>)} />
      </DataPanel>

      <DataPanel title="对账记录">
        <Table
          rowKey="id"
          pagination={false}
          size="small"
          scroll={{ x: 1200 }}
          dataSource={detail.reconciliations}
          columns={[
            ...reconciliationColumns.slice(0, 8),
            {
              title: '操作',
              key: 'actions',
              render: (_value, row) =>
                props.canManageWorkspace ? (
                  <Space wrap size={4}>
                    <Button
                      size="small"
                      loading={
                        props.busyKey ===
                        `reconciliation-${(row as FundAccountsDetailResponse['reconciliations'][number]).id}-matched`
                      }
                      onClick={() =>
                        void props.onUpdateReconciliationStatus(
                          (row as FundAccountsDetailResponse['reconciliations'][number]).id,
                          'matched',
                        )
                      }
                    >
                      标记匹配
                    </Button>
                    <Button
                      size="small"
                      loading={
                        props.busyKey ===
                        `reconciliation-${(row as FundAccountsDetailResponse['reconciliations'][number]).id}-reviewed`
                      }
                      onClick={() =>
                        void props.onUpdateReconciliationStatus(
                          (row as FundAccountsDetailResponse['reconciliations'][number]).id,
                          'reviewed',
                        )
                      }
                    >
                      标记复核
                    </Button>
                  </Space>
                ) : (
                  <Tag>只读</Tag>
                ),
            },
          ]}
        />
      </DataPanel>

      {detail.notes.length > 0 ? (
        <DataPanel title="说明">
          <Space direction="vertical" size={8}>
            {detail.notes.map((item) => (
              <Typography.Text key={item}>{item}</Typography.Text>
            ))}
          </Space>
        </DataPanel>
      ) : null}
    </Space>
  );
}

function FundWithdrawalsSection({
  detail,
  props,
}: {
  detail: FundWithdrawalsDetailResponse;
  props: WorkspaceBusinessSectionProps;
}) {
  const [withdrawalAmount, setWithdrawalAmount] = useState<number | null>(null);
  const [withdrawalStoreId, setWithdrawalStoreId] = useState<number | undefined>(undefined);
  const [withdrawalMethod, setWithdrawalMethod] = useState('支付宝');
  const [withdrawalAccount, setWithdrawalAccount] = useState('');

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <DataPanel title="发起提现">
        <Space wrap>
          <InputNumber min={1} value={withdrawalAmount ?? undefined} onChange={(value) => setWithdrawalAmount(value ?? null)} placeholder="提现金额" />
          <Select allowClear placeholder="选择店铺" style={{ width: 180 }} options={props.storeOptions} value={withdrawalStoreId} onChange={(value) => setWithdrawalStoreId(value)} />
          <Input value={withdrawalMethod} onChange={(event) => setWithdrawalMethod(event.target.value)} placeholder="提现方式" style={{ width: 160 }} />
          <Input value={withdrawalAccount} onChange={(event) => setWithdrawalAccount(event.target.value)} placeholder="收款账号" style={{ width: 220 }} />
          <Button
            type="primary"
            disabled={!props.canManageWorkspace || !withdrawalAmount || !withdrawalMethod.trim() || !withdrawalAccount.trim()}
            loading={props.busyKey === 'withdrawal-create'}
            onClick={() =>
              void props.onCreateWithdrawal({
                amount: withdrawalAmount ?? 0,
                storeId: withdrawalStoreId,
                method: withdrawalMethod.trim(),
                receivingAccount: withdrawalAccount.trim(),
              })
            }
          >
            提交提现
          </Button>
        </Space>
      </DataPanel>

      <DataPanel title="提现记录">
        <Table
          rowKey="id"
          pagination={false}
          size="small"
          scroll={{ x: 1280 }}
          dataSource={detail.rows}
          columns={[
            { title: '提现单号', dataIndex: 'withdrawalNo' },
            { title: '店铺', dataIndex: 'storeName', render: (value) => value ?? '-' },
            { title: '方式', dataIndex: 'method' },
            { title: '金额', render: (_value, row) => `¥${amountText(row.amount)}` },
            { title: '到账金额', render: (_value, row) => `¥${amountText(row.arrivalAmount)}` },
            { title: '状态', dataIndex: 'status' },
            { title: '备注', dataIndex: 'reviewRemark', render: (value) => value || '-' },
            { title: '时间', dataIndex: 'tradeTime' },
            {
              title: '操作',
              render: (_value, row) =>
                props.canApproveWithdrawals ? (
                  <Space wrap size={4}>
                    <Button size="small" loading={props.busyKey === `withdrawal-${row.id}-paid`} onClick={() => void props.onUpdateWithdrawalStatus(row.id, 'paid')}>
                      通过
                    </Button>
                    <Button size="small" loading={props.busyKey === `withdrawal-${row.id}-rejected`} onClick={() => void props.onUpdateWithdrawalStatus(row.id, 'rejected')}>
                      驳回
                    </Button>
                  </Space>
                ) : (
                  <Tag>只读</Tag>
                ),
            },
          ]}
        />
      </DataPanel>
    </Space>
  );
}

export function WorkspaceBusinessSection(props: WorkspaceBusinessSectionProps) {
  const { detail } = props;

  const selectedSecurityDetail = useMemo(() => {
    if (detail.kind === 'none') {
      return null;
    }
    if (detail.kind === 'system-accounts' || detail.kind === 'open-logs' || detail.kind === 'system-configs') {
      return detail as SystemAccountsDetailResponse | OpenLogsDetailResponse | SystemConfigsDetailResponse;
    }
    return null;
  }, [detail]);

  if (selectedSecurityDetail) {
    return (
      <SecurityWorkspaceSection
        detail={selectedSecurityDetail}
        busyKey={props.busyKey}
        canManageUsers={props.canManageUsers}
        canManageSecureSettings={props.canManageSecureSettings}
        onCreateSystemUser={props.onCreateSystemUser}
        onUpdateSystemUserRole={props.onUpdateSystemUserRole}
        onUpdateSystemUserStatus={props.onUpdateSystemUserStatus}
        onUpdateSecureSetting={props.onUpdateSecureSetting}
      />
    );
  }

  if (detail.kind === 'none') {
    return <Empty description="当前模块暂未接入业务面板" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  let content: ReactNode;
  if (detail.kind === 'ai-service') {
    content = renderAiService(detail, props);
  } else if (detail.kind === 'distribution-source') {
    content = renderDistributionSource(detail, props);
  } else if (detail.kind === 'distribution-supply') {
    content = renderDistributionSupply(detail, props);
  } else if (detail.kind === 'system-monitoring') {
    content = renderSystemMonitoring(detail, props);
  } else if (detail.kind === 'fund-accounts') {
    content = renderFundAccounts(detail, props);
  } else if (detail.kind === 'fund-withdrawals') {
    content = <FundWithdrawalsSection detail={detail} props={props} />;
  } else {
    content = renderGenericContent(detail);
  }

  if (detail.kind === 'ai-service') {
    return <>{content}</>;
  }

  return (
    <>
      <div className="module-panel">
        <div className="workspace-business-header">
          <div>
            <Typography.Title level={4} style={{ marginBottom: 6 }}>
              {detail.title}
            </Typography.Title>
            <Typography.Text type="secondary">{detail.description}</Typography.Text>
          </div>
          {detail.kind === 'ai-bargain' && props.canManageWorkspace ? (
            <Button
              type="primary"
              loading={props.busyKey === 'ai-bargain-sync'}
              onClick={() => void props.onSyncAiBargainSessions()}
            >
              同步真实会话
            </Button>
          ) : null}
        </div>
        {renderMetrics(detail.metrics)}
      </div>

      {content}
    </>
  );
}
