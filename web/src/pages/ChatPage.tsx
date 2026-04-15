import {
  CustomerServiceOutlined,
  LinkOutlined,
  MessageOutlined,
  ReloadOutlined,
  RobotOutlined,
  SettingOutlined,
  ShopOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { Button, Card, Col, Row, Space, Switch, Tag, Typography, message } from 'antd';
import { useCallback, useState } from 'react';

import { apiRequest } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';

interface ChatOverviewData {
  settings?: {
    aiEnabled: boolean;
    autoReplyEnabled: boolean;
    highRiskManualOnly: boolean;
    boundaryNote?: string;
    modelKeyMasked?: string;
  };
  conversations: Array<{
    id: number;
    customerName: string;
    conversationStatus: string;
    riskLevel: string;
  }>;
  title: string;
}

const XIANYU_LINKS = [
  { label: '闲鱼消息中心', url: 'https://www.goofish.com/channels/sender', icon: <MessageOutlined />, desc: '直接打开闲鱼 Web 端消息，实时和买家沟通' },
  { label: '卖家工作台', url: 'https://www.goofish.com/sale', icon: <ShopOutlined />, desc: '管理商品、查看库存、处理订单' },
  { label: '闲鱼首页', url: 'https://www.goofish.com/', icon: <CustomerServiceOutlined />, desc: '浏览闲鱼主站首页' },
];

export function ChatPage() {
  const [messageApi, contextHolder] = message.useMessage();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // 加载 AI 客服概要数据
  const loader = useCallback(async () => {
    try {
      const result = await apiRequest<ChatOverviewData>(
        '/api/workspaces/ai-service/detail',
        undefined,
      );
      return result;
    } catch {
      return null;
    }
  }, []);

  const { data, loading, reload } = useRemoteData<ChatOverviewData | null>(loader);

  const wrapAction = useCallback(
    async (key: string, successText: string, fn: () => Promise<void>) => {
      setBusyKey(key);
      try {
        await fn();
        messageApi.success(successText);
        await reload();
      } catch (err) {
        messageApi.error(err instanceof Error ? err.message : '操作失败');
      } finally {
        setBusyKey(null);
      }
    },
    [messageApi, reload],
  );

  const handleToggleSetting = useCallback(
    (settingKey: string, value: boolean) => {
      void wrapAction('ai-settings', 'AI 客服策略已更新', async () => {
        await apiRequest(
          '/api/workspaces/ai-service/settings',
          { method: 'POST', body: JSON.stringify({ [settingKey]: value }) },
        );
      });
    },
    [wrapAction],
  );

  const handleSyncConversations = useCallback(() => {
    void wrapAction('sync', '真实会话同步已完成', async () => {
      await apiRequest(
        '/api/workspaces/ai-service/service-sync',
        {
          method: 'POST',
          body: JSON.stringify({ maxSessionsPerStore: 50, maxMessagesPerSession: 50 }),
        },
      );
    });
  }, [wrapAction]);

  const settings = data?.settings;
  const conversationCount = data?.conversations?.length ?? 0;
  const manualCount = data?.conversations?.filter((c) => c.conversationStatus === 'manual_active').length ?? 0;
  const riskCount = data?.conversations?.filter((c) => c.riskLevel === 'high').length ?? 0;

  return (
    <div className="page-grid" style={{ maxWidth: 1200, margin: '0 auto' }}>
      {contextHolder}

      {/* ── 顶部区域 ── */}
      <div className="chat-hub-hero">
        <div className="chat-hub-hero-left">
          <Tag color="purple">AI 客服</Tag>
          <Typography.Title level={3} style={{ margin: '8px 0 4px' }}>
            闲鱼智能客服中心
          </Typography.Title>
          <Typography.Text type="secondary">
            管理 AI 回复策略、同步真实会话、一键跳转闲鱼聊天。后端 AI 引擎持续运行，无需在此页面保持打开。
          </Typography.Text>
        </div>
        <Space wrap>
          <Button
            type="primary"
            icon={<SyncOutlined />}
            loading={busyKey === 'sync'}
            onClick={handleSyncConversations}
          >
            同步真实会话
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => void reload()}>
            刷新状态
          </Button>
        </Space>
      </div>

      {/* ── 统计卡片 ── */}
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={6}>
          <div className="chat-hub-stat-card">
            <div className="chat-hub-stat-label">总会话</div>
            <div className="chat-hub-stat-value">{conversationCount}</div>
          </div>
        </Col>
        <Col xs={12} sm={6}>
          <div className="chat-hub-stat-card">
            <div className="chat-hub-stat-label">待人工</div>
            <div className="chat-hub-stat-value chat-hub-stat-warning">{manualCount}</div>
          </div>
        </Col>
        <Col xs={12} sm={6}>
          <div className="chat-hub-stat-card">
            <div className="chat-hub-stat-label">高风险</div>
            <div className="chat-hub-stat-value chat-hub-stat-danger">{riskCount}</div>
          </div>
        </Col>
        <Col xs={12} sm={6}>
          <div className="chat-hub-stat-card">
            <div className="chat-hub-stat-label">AI 状态</div>
            <div className="chat-hub-stat-value">
              <Tag color={settings?.aiEnabled ? 'success' : 'default'}>
                {settings?.aiEnabled ? '运行中' : '关闭'}
              </Tag>
            </div>
          </div>
        </Col>
      </Row>

      {/* ── 快捷跳转闲鱼 ── */}
      <Card
        className="glass-panel"
        title={
          <Space>
            <MessageOutlined />
            <span>闲鱼聊天入口</span>
            <Tag color="blue">推荐</Tag>
          </Space>
        }
        bordered={false}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          点击下方按钮直接在浏览器新标签页中打开闲鱼官方页面。您在闲鱼上与买家的对话会被后端自动同步，AI 引擎会实时根据策略进行自动回复。
        </Typography.Paragraph>
        <div className="chat-hub-link-grid">
          {XIANYU_LINKS.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="chat-hub-link-card"
            >
              <div className="chat-hub-link-icon">{link.icon}</div>
              <div className="chat-hub-link-body">
                <strong>{link.label}</strong>
                <span>{link.desc}</span>
              </div>
              <LinkOutlined className="chat-hub-link-arrow" />
            </a>
          ))}
        </div>
      </Card>

      {/* ── AI 设置面板 ── */}
      <Card
        className="glass-panel"
        title={
          <Space>
            <RobotOutlined />
            <span>AI 客服策略</span>
          </Space>
        }
        bordered={false}
        loading={loading}
      >
        <div className="chat-hub-settings-grid">
          <div className="chat-hub-setting-row">
            <div>
              <strong>AI 客服总开关</strong>
              <p>开启后 AI 将自动参与新消息的应答</p>
            </div>
            <Switch
              checked={settings?.aiEnabled ?? false}
              loading={busyKey === 'ai-settings'}
              onChange={(checked) => handleToggleSetting('aiEnabled', checked)}
            />
          </div>
          <div className="chat-hub-setting-row">
            <div>
              <strong>自动回复</strong>
              <p>自动将 AI 生成的回复直接发送给买家</p>
            </div>
            <Switch
              checked={settings?.autoReplyEnabled ?? false}
              loading={busyKey === 'ai-settings'}
              onChange={(checked) => handleToggleSetting('autoReplyEnabled', checked)}
            />
          </div>
          <div className="chat-hub-setting-row">
            <div>
              <strong>高风险仅人工</strong>
              <p>高风险会话仅允许人工接管，AI 不介入</p>
            </div>
            <Switch
              checked={settings?.highRiskManualOnly ?? false}
              loading={busyKey === 'ai-settings'}
              onChange={(checked) => handleToggleSetting('highRiskManualOnly', checked)}
            />
          </div>
        </div>

        {settings?.boundaryNote && (
          <div className="chat-hub-boundary-note">
            <SettingOutlined /> 服务边界：{settings.boundaryNote}
          </div>
        )}
        {settings?.modelKeyMasked && (
          <div className="chat-hub-model-info">
            <RobotOutlined /> 当前模型密钥：{settings.modelKeyMasked}
          </div>
        )}
      </Card>
    </div>
  );
}
