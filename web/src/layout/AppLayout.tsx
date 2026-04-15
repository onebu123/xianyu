import {
  BellOutlined,
  CustomerServiceOutlined,
  LogoutOutlined,
  MenuOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Drawer, Layout, Tag, message } from 'antd';
import { useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth';
import { canAccessNavigationItem, getRoleLabel } from '../access';
import { ChangePasswordButton } from '../components/ChangePasswordButton';
import { navigationGroups } from '../navigation';

const { Header, Sider, Content } = Layout;

export function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [messageApi, contextHolder] = message.useMessage();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const visibleGroups = navigationGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canAccessNavigationItem(user?.role, item)),
    }))
    .filter((group) => group.items.length > 0);

  const isChatFirstRoute = location.pathname.startsWith('/workspace/ai-service');

  const handleLogout = async () => {
    if (loggingOut) {
      return;
    }

    setLoggingOut(true);
    try {
      await logout();
      navigate('/login', { replace: true });
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : '退出登录失败，请稍后重试');
    } finally {
      setLoggingOut(false);
    }
  };

  const renderNavigation = (mode: 'desktop' | 'mobile') => (
    <div className={`app-sider-scroll${mode === 'mobile' ? ' is-mobile' : ''}`}>
      <div className="app-sider-brand">
        <div className="app-brand-logo">鱼</div>
        <div className="app-sider-brand-text">
          <span className="app-sider-brand-name">Sale Compass</span>
          <span className="app-sider-brand-sub">经营控制台</span>
        </div>
      </div>

      {visibleGroups.map((group) => (
        <div key={group.key} className="nav-group">
          <div className="nav-group-title">
            {group.icon}
            <span>{group.label}</span>
          </div>
          <div className="nav-group-items">
            {group.items.map((item) => {
              const active =
                location.pathname === item.path ||
                (item.path !== '/' && location.pathname.startsWith(`${item.path}/`));

              return (
                <button
                  key={item.key}
                  type="button"
                  className={`nav-item-button${active ? ' is-active' : ''}`}
                  onClick={() => {
                    navigate(item.path);
                    if (mode === 'mobile') {
                      setMobileNavOpen(false);
                    }
                  }}
                >
                  <span className="nav-item-icon">{item.icon}</span>
                  <span className="nav-item-label">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <Layout className="app-shell">
      {contextHolder}
      <div className="app-shell-backdrop" />

      <Drawer
        title={null}
        placement="left"
        width={280}
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        className="mobile-nav-drawer"
        styles={{ body: { padding: 0 } }}
      >
        {renderNavigation('mobile')}
      </Drawer>

      <Header className={`app-shell-header${isChatFirstRoute ? ' is-chat-route' : ''}`}>
        <div className="app-shell-header-top">
          <div className="app-shell-brand-row">
            <Button
              type="text"
              icon={<MenuOutlined />}
              className="mobile-nav-trigger"
              onClick={() => setMobileNavOpen(true)}
            />
            <button type="button" className="app-brand" onClick={() => navigate('/dashboard')}>
              <div className="app-brand-copy">
                <div className="app-brand-kicker">SALE COMPASS</div>
                <div className="app-brand-title">闲鱼卖家工作台</div>
              </div>
            </button>
          </div>

          <div className="app-shell-actions">
            <div className="app-shell-status-group">
              <Tag className="shell-tag shell-tag-primary" bordered={false}>
                <SafetyCertificateOutlined /> 安全模式
              </Tag>
            </div>
            <div className="app-shell-utility-group">
              <button
                type="button"
                className="header-link-button"
                onClick={() => navigate('/workspace/ai-service')}
              >
                <CustomerServiceOutlined /> 客服
              </button>
              <button
                type="button"
                className="header-link-button"
                onClick={() => navigate('/workspace/system-monitoring')}
              >
                <BellOutlined /> 通知
              </button>
              <div className="header-user-box">
                <Avatar
                  icon={<UserOutlined />}
                  className="header-user-avatar"
                  style={{ background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' }}
                />
                <div>
                  <div className="header-user-name">{user?.displayName}</div>
                  <div className="header-user-role">{getRoleLabel(user?.role)}</div>
                </div>
              </div>
              <ChangePasswordButton />
              <Button
                icon={<LogoutOutlined />}
                className="shell-ghost-button"
                loading={loggingOut}
                onClick={() => void handleLogout()}
              >
                退出
              </Button>
            </div>
          </div>
        </div>
      </Header>

      <Layout className="app-shell-main">
        <Sider width={260} className="app-shell-sider">
          {renderNavigation('desktop')}
        </Sider>
        <Content className="app-shell-content">
          <div className={`app-content-inner${isChatFirstRoute ? ' is-chat-route' : ''}`}>
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
