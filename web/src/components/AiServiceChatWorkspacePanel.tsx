import { Avatar, Button, Empty, Input, Space, Tag, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

import type { AiServiceDetailResponse } from '../api';

type AiServiceConversation = AiServiceDetailResponse['conversations'][number];
type AiServiceMessage = AiServiceDetailResponse['recentMessages'][number];
type AiServiceTakeover = AiServiceDetailResponse['takeovers'][number];
type AiServiceKnowledgeItem = AiServiceDetailResponse['knowledgeItems'][number];
type AiServiceReplyTemplate = AiServiceDetailResponse['replyTemplates'][number];
type AiServiceSidebarTab = 'service' | 'quick-reply' | 'product' | 'order' | 'customer';
type AiServiceConversationFilter = 'all' | 'manual' | 'risk' | 'closed';

interface AiServiceChatWorkspacePanelProps {
  detail: AiServiceDetailResponse;
  props: {
    busyKey: string | null;
    canManageWorkspace: boolean;
    onGenerateAiServiceReply: (conversationId: number) => Promise<void>;
    onUpdateAiServiceTakeover: (conversationId: number, action: 'takeover' | 'release') => Promise<void>;
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
  };
}

function aiServiceRiskColor(riskLevel: string) {
  if (riskLevel === 'high') {
    return 'error';
  }
  if (riskLevel === 'medium') {
    return 'warning';
  }
  return 'default';
}

function aiServiceStatusColor(status: string) {
  if (status === 'manual_active') {
    return 'processing';
  }
  if (status === 'resolved') {
    return 'success';
  }
  if (status === 'waiting_customer') {
    return 'default';
  }
  return 'gold';
}

function formatAiServiceTimeLabel(value: string | null | undefined) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function buildAiServiceInitials(value: string | null | undefined) {
  const compactValue = value?.replace(/\s+/g, '').trim() ?? '';
  return compactValue.slice(0, 2) || '客服';
}

function normalizeAiServiceImageUrl(value: string | null | undefined) {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith('//')) {
    return `https:${normalized}`;
  }
  return normalized;
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
  return '暂无最新消息';
}

function AiServiceInfoList({
  items,
}: {
  items: Array<{ label: string; value: ReactNode }>;
}) {
  return (
    <div className="ai-service-info-list">
      {items.map((item) => (
        <div key={item.label} className="ai-service-info-item">
          <span className="ai-service-info-label">{item.label}</span>
          <div className="ai-service-info-value">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

function AiServiceStatePill({
  tone,
  children,
}: {
  tone: 'neutral' | 'positive' | 'warning' | 'danger' | 'accent';
  children: ReactNode;
}) {
  return <span className={`ai-service-state-pill is-${tone}`}>{children}</span>;
}

export function AiServiceChatWorkspacePanel({ detail, props }: AiServiceChatWorkspacePanelProps) {
  const [searchText, setSearchText] = useState('');
  const [conversationFilter, setConversationFilter] = useState<AiServiceConversationFilter>('all');
  const [selectedConversationId, setSelectedConversationId] = useState<number | null>(null);
  const [sidebarTab, setSidebarTab] = useState<AiServiceSidebarTab>('service');
  const [draftsByConversationId, setDraftsByConversationId] = useState<Record<number, string>>({});
  const messageListRef = useRef<HTMLDivElement | null>(null);

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

  const selectedConversation = useMemo(() => {
    const currentSelection = detail.conversations.find((item) => item.id === selectedConversationId) ?? null;
    if (
      currentSelection &&
      (filteredConversations.length === 0 || filteredConversations.some((item) => item.id === currentSelection.id))
    ) {
      return currentSelection;
    }
    return detail.conversations.find((item) => item.id === fallbackConversationId) ?? null;
  }, [detail.conversations, fallbackConversationId, filteredConversations, selectedConversationId]);

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
  const trimmedDraft = currentDraft.trim();
  const settings = detail.settings;
  const activeStoreName = selectedConversation?.storeName ?? detail.conversations[0]?.storeName ?? detail.title;
  const isRealConversation = selectedConversation?.source.includes('真实') ?? false;
  const syncNotices = detail.syncNotices ?? [];
  const actionableSyncNotices = syncNotices.filter((item) => Boolean(item.verificationUrl));

  const filterOptions: Array<{ key: AiServiceConversationFilter; label: string; count: number }> = [
    { key: 'all', label: '全部', count: filterCounts.all },
    { key: 'manual', label: '待人工', count: filterCounts.manual },
    { key: 'risk', label: '高风险', count: filterCounts.risk },
    { key: 'closed', label: '已结束', count: filterCounts.closed },
  ];

  const sidebarTabs: Array<{ key: AiServiceSidebarTab; label: string }> = [
    { key: 'service', label: '客服' },
    { key: 'quick-reply', label: '快捷回复' },
    { key: 'product', label: '商品' },
    { key: 'order', label: '订单' },
    { key: 'customer', label: '客户' },
  ];

  const threadOverviewItems = selectedConversation
    ? [
        {
          key: 'source',
          label: '当前会话',
          value: isRealConversation ? '真实闲鱼会话' : '本地会话',
          helper: selectedConversation.source,
        },
        {
          key: 'order',
          label: '订单与未读',
          value: selectedConversation.orderNo ?? '暂无订单',
          helper: `未读 ${selectedConversation.unreadCount} 条`,
        },
        {
          key: 'session',
          label: '会话编号',
          value: selectedConversation.sessionNo,
          helper: selectedConversation.assignedUserName ?? '未指派客服',
        },
      ]
    : [];

  const composerTools = [
    { key: 'quick-reply' as const, label: '快捷话术' },
    { key: 'order' as const, label: '订单信息' },
    { key: 'customer' as const, label: '客户信息' },
  ];

  const runtimeNotes = [
    detail.settings?.boundaryNote
      ? { title: '服务边界', content: detail.settings.boundaryNote }
      : null,
    detail.settings?.sensitiveWordsText
      ? { title: '敏感词提醒', content: detail.settings.sensitiveWordsText }
      : null,
    ...detail.notes.map((note, index) => ({
      title: `运行提示 ${index + 1}`,
      content: note,
    })),
  ].filter((item): item is { title: string; content: string } => Boolean(item?.content));

  const sidebarTabCounts: Record<AiServiceSidebarTab, number> = {
    service: runtimeNotes.length + selectedTakeovers.length + syncNotices.length,
    'quick-reply': quickReplyCards.length,
    product: selectedConversation?.tags.length ?? 0,
    order: selectedConversation?.orderNo || selectedConversation?.caseNo ? 1 : 0,
    customer: selectedConversation?.unreadCount ?? 0,
  };

  const serviceInfoItems = selectedConversation
    ? [
        { label: '买家', value: selectedConversation.customerName },
        { label: '店铺', value: selectedConversation.storeName ?? '-' },
        { label: '会话来源', value: selectedConversation.source },
        { label: '最新意图', value: selectedConversation.latestUserIntent || '-' },
        { label: 'AI 状态', value: selectedConversation.aiStatusText },
        { label: '模型密钥', value: detail.settings?.modelKeyMasked || '未配置' },
      ]
    : [];

  const productInfoItems = selectedConversation
    ? [
        { label: '会话主题', value: selectedConversation.topic },
        { label: '边界标签', value: selectedConversation.boundaryLabel },
        { label: '优先级', value: selectedConversation.priority },
        { label: '会话标签', value: selectedConversation.tags.length ? selectedConversation.tags.join(' / ') : '-' },
        { label: '最新意图', value: selectedConversation.latestUserIntent || '-' },
      ]
    : [];

  const orderInfoItems = selectedConversation
    ? [
        { label: '订单号', value: selectedConversation.orderNo ?? '-' },
        { label: '售后单号', value: selectedConversation.caseNo ?? '-' },
        { label: '最近消息时间', value: formatAiServiceTimeLabel(selectedConversation.lastMessageAt) },
        { label: '会话状态', value: selectedConversation.conversationStatusText },
        { label: '未读消息', value: String(selectedConversation.unreadCount) },
        { label: '当前 AI 状态', value: selectedConversation.aiStatusText },
      ]
    : [];

  const customerInfoItems = selectedConversation
    ? [
        { label: '客户昵称', value: selectedConversation.customerName },
        { label: '渠道', value: selectedConversation.channel },
        { label: '会话编号', value: selectedConversation.sessionNo },
        { label: '所属店铺', value: selectedConversation.storeName ?? '-' },
        { label: '指派客服', value: selectedConversation.assignedUserName ?? '未指派' },
        { label: '未读消息', value: String(selectedConversation.unreadCount) },
      ]
    : [];

  const serviceSwitchCards = settings
    ? [
        {
          key: 'ai',
          title: 'AI 客服',
          description: settings.aiEnabled ? '当前由 AI 协同接待' : '当前仅人工处理会话',
          enabled: settings.aiEnabled,
          tone: 'positive' as const,
          actionLabel: settings.aiEnabled ? '关闭' : '开启',
          onClick: () =>
            void props.onUpdateAiServiceSettings({
              aiEnabled: !settings.aiEnabled,
            }),
        },
        {
          key: 'auto-reply',
          title: '自动回复',
          description: settings.autoReplyEnabled ? '新消息将自动触发回复建议' : '仅生成草稿，不自动回复',
          enabled: settings.autoReplyEnabled,
          tone: 'accent' as const,
          actionLabel: settings.autoReplyEnabled ? '关闭' : '开启',
          onClick: () =>
            void props.onUpdateAiServiceSettings({
              autoReplyEnabled: !settings.autoReplyEnabled,
            }),
        },
        {
          key: 'risk-control',
          title: '高风险策略',
          description: settings.highRiskManualOnly ? '高风险会话仅允许人工接管' : '允许 AI 协助处理高风险会话',
          enabled: settings.highRiskManualOnly,
          tone: 'warning' as const,
          actionLabel: settings.highRiskManualOnly ? '允许 AI' : '改为人工',
          onClick: () =>
            void props.onUpdateAiServiceSettings({
              highRiskManualOnly: !settings.highRiskManualOnly,
            }),
        },
      ]
    : [];

  const applyQuickReply = (content: string) => {
    const nextContent = content.trim();
    if (!nextContent || !selectedConversation) {
      return;
    }
    setDraftsByConversationId((current) => {
      const previousDraft = current[selectedConversation.id] ?? '';
      return {
        ...current,
        [selectedConversation.id]: previousDraft.trim()
          ? `${previousDraft.trim()}\n${nextContent}`
          : nextContent,
      };
    });
  };

  const openVerificationNotice = (verificationUrl: string | null) => {
    if (!verificationUrl) {
      return;
    }
    window.open(verificationUrl, '_blank', 'noopener,noreferrer');
  };

  const handleSendManualReply = (closeConversation: boolean) => {
    if (!selectedConversation || !trimmedDraft) {
      return;
    }
    void props
      .onSendAiServiceManualReply(selectedConversation.id, trimmedDraft, closeConversation)
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

  useEffect(() => {
    const messageListElement = messageListRef.current;
    if (!messageListElement) {
      return;
    }
    messageListElement.scrollTop = messageListElement.scrollHeight;
  }, [selectedConversation?.id, selectedMessages.length]);

  const handleComposerPressEnter = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    if (!props.canManageWorkspace || !trimmedDraft || isSendBusy) {
      return;
    }
    handleSendManualReply(false);
  };

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
            <Avatar
              size={30}
              src={normalizeAiServiceImageUrl(selectedConversation?.itemMainPic)}
              className="ai-service-chat-session-avatar ai-service-chat-app-avatar"
            >
              {buildAiServiceInitials(activeStoreName)}
            </Avatar>
            <div>
              <strong>{activeStoreName}</strong>
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
            {actionableSyncNotices.length > 0 ? (
              <span className="ai-service-chat-mode-badge is-warning">待验证 {actionableSyncNotices.length}</span>
            ) : null}
            <span className={`ai-service-chat-mode-badge ${settings?.aiEnabled ? 'is-on' : ''}`}>
              {settings?.aiEnabled ? 'AI 客服已开启' : 'AI 客服已关闭'}
            </span>
            <span className={`ai-service-chat-mode-badge ${settings?.autoReplyEnabled ? 'is-on' : ''}`}>
              {settings?.autoReplyEnabled ? '自动回复开启' : '人工优先'}
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

      {syncNotices.length > 0 ? (
        <div className="ai-service-chat-notice-stack">
          {syncNotices.map((notice) => (
            <div
              key={`${notice.storeId}-${notice.updatedAt}-${notice.verificationUrl ?? 'notice'}`}
              className={`ai-service-chat-notice-card is-${notice.riskLevel}`}
            >
              <div className="ai-service-chat-notice-copy">
                <strong>{notice.storeName} 验证提醒</strong>
                <p>{notice.detail}</p>
                <span>{notice.updatedAt ? `最近更新 ${formatAiServiceTimeLabel(notice.updatedAt)}` : '等待处理'}</span>
              </div>
              <Space wrap>
                {notice.verificationUrl ? (
                  <Button type="primary" onClick={() => openVerificationNotice(notice.verificationUrl)}>
                    前往验证
                  </Button>
                ) : null}
                {props.canManageWorkspace ? (
                  <Button onClick={() => void props.onSyncAiServiceConversations()}>重试同步</Button>
                ) : null}
              </Space>
            </div>
          ))}
        </div>
      ) : null}

      <div className="ai-service-chat-shell">
        <aside className="ai-service-chat-sidebar">
          <div className="ai-service-chat-sidebar-head">
            <div className="ai-service-chat-sidebar-profile">
              <Avatar
                size={48}
                src={normalizeAiServiceImageUrl(selectedConversation?.itemMainPic)}
                className="ai-service-chat-session-avatar"
              >
                {buildAiServiceInitials(activeStoreName)}
              </Avatar>
              <div className="ai-service-chat-sidebar-profile-main">
                <div className="ai-service-chat-sidebar-title-row">
                  <strong>{activeStoreName}</strong>
                  <span className={`ai-service-chat-online ${settings?.aiEnabled ? 'is-online' : ''}`}>
                    {settings?.aiEnabled ? '在线' : '待机'}
                  </span>
                </div>
                <div className="ai-service-chat-sidebar-subtitle">
                  先看会话，再处理消息。右侧信息跟随当前会话联动。
                </div>
              </div>
            </div>
            <div className="ai-service-chat-sidebar-summary">
              <span>真实会话 {detail.conversations.length}</span>
              <span>已结束 {filterCounts.closed}</span>
            </div>
          </div>

          <Input
            allowClear
            value={searchText}
            className="ai-service-chat-search"
            placeholder="搜索联系人 / 订单 / 备注"
            onChange={(event) => setSearchText(event.target.value)}
          />

          <div className="ai-service-chat-filter-row">
            {filterOptions.map((item) => (
              <button
                type="button"
                key={item.key}
                className={`ai-service-chat-filter-chip ${conversationFilter === item.key ? 'is-active' : ''}`}
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
                    <Avatar
                      size={42}
                      src={normalizeAiServiceImageUrl(conversation.itemMainPic)}
                      className="ai-service-chat-session-avatar"
                    >
                      {buildAiServiceInitials(conversation.customerName)}
                    </Avatar>
                    <div className="ai-service-chat-session-body">
                      <div className="ai-service-chat-session-topline">
                        <strong>{conversation.customerName}</strong>
                        <span>{formatAiServiceTimeLabel(conversation.lastMessageAt)}</span>
                      </div>
                      <div className="ai-service-chat-session-preview">
                        {resolveAiServiceMessagePreview(conversation, latestMessage)}
                      </div>
                      <div className="ai-service-chat-session-footline">
                        <span className="ai-service-chat-session-topic">{conversation.topic}</span>
                        <div className="ai-service-chat-session-tags">
                          {conversation.unreadCount > 0 ? (
                            <span className="ai-service-chat-session-badge is-unread">
                              {conversation.unreadCount}
                            </span>
                          ) : null}
                          <span
                            className={`ai-service-chat-session-badge is-risk-${conversation.riskLevel}`}
                          >
                            {conversation.riskLevelText}
                          </span>
                          <span className="ai-service-chat-session-badge is-status">
                            {conversation.aiStatusText}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={searchText.trim() ? '没有匹配到会话' : '暂时没有客服会话'}
              />
            )}
          </div>
        </aside>
        <section className="ai-service-chat-thread">
          {selectedConversation ? (
            <>
              <div className="ai-service-chat-thread-header">
                <div className="ai-service-chat-thread-profile">
                  <Avatar
                    size={52}
                    src={normalizeAiServiceImageUrl(selectedConversation.itemMainPic)}
                    className="ai-service-chat-session-avatar"
                  >
                    {buildAiServiceInitials(selectedConversation.customerName)}
                  </Avatar>
                  <div className="ai-service-chat-thread-meta">
                    <div className="ai-service-chat-thread-name-row">
                      <Typography.Title level={4} style={{ margin: 0 }}>
                        {selectedConversation.customerName}
                      </Typography.Title>
                      <span className="ai-service-chat-thread-status">
                        {isRealConversation ? '真实闲鱼会话' : '本地会话'}
                      </span>
                    </div>
                    <div className="ai-service-chat-thread-note">
                      <span>{selectedConversation.topic}</span>
                      <span>{formatAiServiceTimeLabel(selectedConversation.lastMessageAt)}</span>
                      {selectedConversation.orderNo ? <span>订单 {selectedConversation.orderNo}</span> : null}
                    </div>
                    <div className="ai-service-chat-thread-tags">
                      {selectedConversation.storeName ? <Tag>{selectedConversation.storeName}</Tag> : null}
                      <Tag color={aiServiceRiskColor(selectedConversation.riskLevel)}>
                        {selectedConversation.riskLevelText}
                      </Tag>
                      <Tag color={aiServiceStatusColor(selectedConversation.conversationStatus)}>
                        {selectedConversation.conversationStatusText}
                      </Tag>
                      <Tag>{selectedConversation.boundaryLabel}</Tag>
                      {selectedConversation.assignedUserName ? (
                        <Tag color="processing">客服 {selectedConversation.assignedUserName}</Tag>
                      ) : null}
                    </div>
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

              <div className="ai-service-chat-thread-overview">
                {threadOverviewItems.map((item) => (
                  <div key={item.key} className="ai-service-chat-thread-overview-card">
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                    <small>{item.helper}</small>
                  </div>
                ))}
              </div>

              <div className="ai-service-chat-thread-surface">
                <div ref={messageListRef} className="ai-service-chat-message-list">
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
                          {isCustomerMessage ? (
                            <Avatar size={34} className="ai-service-chat-message-avatar">
                              {buildAiServiceInitials(message.customerName)}
                            </Avatar>
                          ) : null}
                          <div
                            className={`ai-service-chat-message-bubble ${
                              isCustomerMessage ? 'is-customer' : 'is-agent'
                            } ${message.status === 'failed' ? 'is-failed' : ''}`}
                          >
                            <div className="ai-service-chat-message-meta">
                              <strong>
                                {(message.senderName || '').trim() ||
                                  (isCustomerMessage ? message.customerName : message.senderTypeText)}
                              </strong>
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
                  {!quickComposerCards.length ? (
                    <Typography.Text type="secondary">暂无可直接带入的常用话术</Typography.Text>
                  ) : null}
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

                <div className="ai-service-chat-composer-tools">
                  <div className="ai-service-chat-composer-tool-row">
                    {composerTools.map((item) => (
                      <button
                        type="button"
                        key={item.key}
                        className={`ai-service-chat-tool-chip ${sidebarTab === item.key ? 'is-active' : ''}`}
                        onClick={() => setSidebarTab(item.key)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <span className="ai-service-chat-composer-hint">Enter 发送，Shift + Enter 换行</span>
                </div>

                <Input.TextArea
                  autoSize={{ minRows: 4, maxRows: 8 }}
                  value={currentDraft}
                  disabled={!props.canManageWorkspace}
                  placeholder="输入人工回复，或先点击上方快捷话术带入输入框。"
                  onPressEnter={handleComposerPressEnter}
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
                    {isRealConversation
                      ? '当前是你的真实闲鱼会话，点击发送后会直接发给买家。'
                      : '当前是本地客服会话，消息只保留在系统内。'}
                  </Typography.Text>
                  <Space wrap>
                    <Button
                      type="primary"
                      disabled={!props.canManageWorkspace || !trimmedDraft}
                      loading={isSendBusy && props.busyKey === `ai-manual-${selectedConversation.id}`}
                      onClick={() => handleSendManualReply(false)}
                    >
                      发送
                    </Button>
                    <Button
                      disabled={!props.canManageWorkspace || !trimmedDraft}
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
          {selectedConversation ? (
            <div className="ai-service-chat-sidepanel-summary-card">
              <div className="ai-service-chat-sidepanel-summary-head">
                <div className="ai-service-chat-sidepanel-summary-copy">
                  <strong>{selectedConversation.customerName}</strong>
                  <span>{selectedConversation.storeName ?? detail.title}</span>
                </div>
                <AiServiceStatePill
                  tone={
                    selectedConversation.riskLevel === 'high'
                      ? 'danger'
                      : selectedConversation.riskLevel === 'medium'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {selectedConversation.riskLevelText}
                </AiServiceStatePill>
              </div>
              <div className="ai-service-chat-sidepanel-summary-meta">
                <AiServiceStatePill tone="accent">{selectedConversation.aiStatusText}</AiServiceStatePill>
                <AiServiceStatePill tone="neutral">
                  {selectedConversation.unreadCount > 0 ? `未读 ${selectedConversation.unreadCount}` : '已读'}
                </AiServiceStatePill>
                {selectedConversation.orderNo ? (
                  <AiServiceStatePill tone="neutral">{selectedConversation.orderNo}</AiServiceStatePill>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="ai-service-chat-tab-row">
            {sidebarTabs.map((item) => (
              <button
                type="button"
                key={item.key}
                className={`ai-service-chat-tab ${sidebarTab === item.key ? 'is-active' : ''}`}
                onClick={() => setSidebarTab(item.key)}
              >
                <span>{item.label}</span>
                <strong className="ai-service-chat-tab-count">{sidebarTabCounts[item.key]}</strong>
              </button>
            ))}
          </div>

          <div className="ai-service-chat-sidecontent">
            {selectedConversation ? (
              <>
                {sidebarTab === 'service' ? (
                  <>
                    {syncNotices.length > 0 ? (
                      <div className="ai-service-side-section">
                        <div className="ai-service-side-section-head">
                          <div className="ai-service-side-section-title">验证入口</div>
                          <span className="ai-service-side-section-caption">{syncNotices.length} 条</span>
                        </div>
                        <div className="ai-service-side-card-list">
                          {syncNotices.map((notice) => (
                            <div
                              key={`side-${notice.storeId}-${notice.updatedAt}-${notice.verificationUrl ?? 'notice'}`}
                              className="ai-service-side-card ai-service-side-card-highlight"
                            >
                              <div className="ai-service-side-card-head">
                                <strong>{notice.storeName}</strong>
                                <AiServiceStatePill
                                  tone={
                                    notice.riskLevel === 'abnormal'
                                      ? 'danger'
                                      : notice.riskLevel === 'offline'
                                        ? 'warning'
                                        : 'accent'
                                  }
                                >
                                  {notice.verificationUrl ? '待验证' : '待处理'}
                                </AiServiceStatePill>
                              </div>
                              <p>{notice.detail}</p>
                              <Space wrap>
                                {notice.verificationUrl ? (
                                  <Button size="small" type="primary" onClick={() => openVerificationNotice(notice.verificationUrl)}>
                                    前往验证
                                  </Button>
                                ) : null}
                                {props.canManageWorkspace ? (
                                  <Button size="small" onClick={() => void props.onSyncAiServiceConversations()}>
                                    重试同步
                                  </Button>
                                ) : null}
                              </Space>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="ai-service-side-section">
                      <div className="ai-service-side-section-head">
                        <div className="ai-service-side-section-title">客服开关</div>
                        <span className="ai-service-side-section-caption">即时生效</span>
                      </div>
                      {serviceSwitchCards.length > 0 ? (
                        <div className="ai-service-toggle-grid">
                          {serviceSwitchCards.map((item) => (
                            <div
                              key={item.key}
                              className={`ai-service-toggle-card${item.enabled ? ' is-enabled' : ''}`}
                            >
                              <div className="ai-service-toggle-card-main">
                                <div className="ai-service-toggle-card-copy">
                                  <strong>{item.title}</strong>
                                  <p>{item.description}</p>
                                </div>
                                <AiServiceStatePill tone={item.enabled ? item.tone : 'neutral'}>
                                  {item.enabled ? '已开启' : '已关闭'}
                                </AiServiceStatePill>
                              </div>
                              {props.canManageWorkspace ? (
                                <Button
                                  size="small"
                                  className="ai-service-toggle-card-action"
                                  loading={props.busyKey === 'ai-settings'}
                                  onClick={item.onClick}
                                >
                                  {item.actionLabel}
                                </Button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无客服配置" />
                      )}
                    </div>

                    <div className="ai-service-side-section">
                      <div className="ai-service-side-section-head">
                        <div className="ai-service-side-section-title">会话摘要</div>
                        <span className="ai-service-side-section-caption">当前会话</span>
                      </div>
                      <AiServiceInfoList items={serviceInfoItems} />
                    </div>

                    <div className="ai-service-side-section">
                      <div className="ai-service-side-section-head">
                        <div className="ai-service-side-section-title">运行提示</div>
                        <span className="ai-service-side-section-caption">{runtimeNotes.length} 条</span>
                      </div>
                      {runtimeNotes.length > 0 ? (
                        <div className="ai-service-side-card-list">
                          {runtimeNotes.map((item) => (
                            <div key={`${item.title}-${item.content}`} className="ai-service-side-card">
                              <div className="ai-service-side-card-head">
                                <strong>{item.title}</strong>
                              </div>
                              <p>{item.content}</p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无运行提示" />
                      )}
                    </div>

                    <div className="ai-service-side-section">
                      <div className="ai-service-side-section-head">
                        <div className="ai-service-side-section-title">人工接管记录</div>
                        <span className="ai-service-side-section-caption">{selectedTakeovers.length} 条</span>
                      </div>
                      {selectedTakeovers.length > 0 ? (
                        <div className="ai-service-side-timeline">
                          {selectedTakeovers.map((item: AiServiceTakeover) => (
                            <div key={item.id} className="ai-service-side-timeline-item">
                              <strong>{item.actionType === 'takeover' ? '接管' : '释放'}</strong>
                              <span>{item.operatorName}</span>
                              <p>{item.note || '无备注'}</p>
                              <small>{formatAiServiceTimeLabel(item.createdAt)}</small>
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
                      <div className="ai-service-side-section-head">
                        <div className="ai-service-side-section-title">快捷短语</div>
                        <span className="ai-service-side-section-caption">点击即可带入输入框</span>
                      </div>
                      {quickComposerCards.length > 0 ? (
                        <div className="ai-service-side-quick-list">
                          {quickComposerCards.map((item) => (
                            <button
                              type="button"
                              key={item.key}
                              className="ai-service-side-quick-chip"
                              onClick={() => applyQuickReply(item.content)}
                            >
                              <strong>{item.title}</strong>
                              <span>{item.content}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可用短语" />
                      )}
                    </div>

                    <div className="ai-service-side-section">
                      <div className="ai-service-side-section-head">
                        <div className="ai-service-side-section-title">回复模板</div>
                        <span className="ai-service-side-section-caption">{detail.replyTemplates.length} 条</span>
                      </div>
                      {detail.replyTemplates.length > 0 ? (
                        <div className="ai-service-side-card-list">
                          {detail.replyTemplates.map((item: AiServiceReplyTemplate) => (
                            <div key={item.id} className="ai-service-side-card">
                              <div className="ai-service-side-card-head">
                                <strong>{item.title}</strong>
                                <AiServiceStatePill tone={item.enabled ? 'positive' : 'neutral'}>
                                  {item.enabled ? '启用' : '停用'}
                                </AiServiceStatePill>
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
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无回复模板" />
                      )}
                    </div>

                    <div className="ai-service-side-section">
                      <div className="ai-service-side-section-head">
                        <div className="ai-service-side-section-title">知识库</div>
                        <span className="ai-service-side-section-caption">{detail.knowledgeItems.length} 条</span>
                      </div>
                      {detail.knowledgeItems.length > 0 ? (
                        <div className="ai-service-side-card-list">
                          {detail.knowledgeItems.map((item: AiServiceKnowledgeItem) => (
                            <div key={item.id} className="ai-service-side-card">
                              <div className="ai-service-side-card-head">
                                <strong>{item.title}</strong>
                                <AiServiceStatePill
                                  tone={
                                    item.riskLevel === 'high'
                                      ? 'danger'
                                      : item.riskLevel === 'medium'
                                        ? 'warning'
                                        : 'neutral'
                                  }
                                >
                                  {item.riskLevelText}
                                </AiServiceStatePill>
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
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无知识库内容" />
                      )}
                    </div>
                  </>
                ) : null}

                {sidebarTab === 'product' ? (
                  <div className="ai-service-side-section">
                    <div className="ai-service-side-section-head">
                      <div className="ai-service-side-section-title">商品与会话标签</div>
                      <span className="ai-service-side-section-caption">实时联动</span>
                    </div>
                    <AiServiceInfoList items={productInfoItems} />
                  </div>
                ) : null}

                {sidebarTab === 'order' ? (
                  <div className="ai-service-side-section">
                    <div className="ai-service-side-section-head">
                      <div className="ai-service-side-section-title">订单与售后</div>
                      <span className="ai-service-side-section-caption">实时联动</span>
                    </div>
                    <AiServiceInfoList items={orderInfoItems} />
                  </div>
                ) : null}

                {sidebarTab === 'customer' ? (
                  <div className="ai-service-side-section">
                    <div className="ai-service-side-section-head">
                      <div className="ai-service-side-section-title">客户画像</div>
                      <span className="ai-service-side-section-caption">实时联动</span>
                    </div>
                    <AiServiceInfoList items={customerInfoItems} />
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
