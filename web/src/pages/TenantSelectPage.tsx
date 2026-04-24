import { ApartmentOutlined, ArrowRightOutlined, BankOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Col, Empty, Row, Space, Tag, Typography, message } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth';

function membershipRoleLabel(role: string) {
  return (
    {
      owner: '所有者',
      admin: '管理员',
      member: '成员',
      support: '客服',
    }[role] ?? role
  );
}

function tenantStatusColor(status: string) {
  return (
    {
      active: 'success',
      provisioning: 'processing',
      suspended: 'warning',
    }[status] ?? 'default'
  );
}

function tenantStatusLabel(status: string) {
  return (
    {
      active: '运行中',
      provisioning: '开通中',
      suspended: '已暂停',
    }[status] ?? status
  );
}

export function TenantSelectPage() {
  const navigate = useNavigate();
  const [messageApi, contextHolder] = message.useMessage();
  const [selectingTenantId, setSelectingTenantId] = useState<number | null>(null);
  const { memberships, platformUser, selectTenant } = useAuth();

  return (
    <PageContainer
      title="选择租户"
      subTitle="先选择一个企业租户，再进入对应的业务工作台。"
      style={{ paddingInline: 0 }}
      extra={[
        <Button key="platform" onClick={() => navigate('/platform/tenants')}>
          平台控制面
        </Button>,
      ]}
    >
      {contextHolder}
      <div className="page-grid">
        <Alert
          type="info"
          showIcon
          icon={<ApartmentOutlined />}
          message="当前是平台会话"
          description={`已登录平台账号 ${platformUser?.displayName ?? '-'}，请选择一个可访问租户进入。`}
        />

        {memberships.length === 0 ? (
          <div className="glass-panel saas-empty-panel">
            <Empty
              description="当前平台账号还没有分配任何租户成员关系"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            >
              <Button type="primary" onClick={() => navigate('/platform/tenants')}>
                前往租户管理
              </Button>
            </Empty>
          </div>
        ) : (
          <Row gutter={[16, 16]}>
            {memberships.map((item) => (
              <Col xs={24} md={12} xl={8} key={item.tenant.id}>
                <Card className="saas-tenant-card" variant="borderless">
                  <Space direction="vertical" size={14} style={{ width: '100%' }}>
                    <div>
                      <Space wrap style={{ marginBottom: 12 }}>
                        <Tag color={tenantStatusColor(item.tenant.status)}>
                          {tenantStatusLabel(item.tenant.status)}
                        </Tag>
                        <Tag>{membershipRoleLabel(item.membership.membershipRole)}</Tag>
                      </Space>
                      <Typography.Title level={4} style={{ margin: 0 }}>
                        {item.tenant.displayName}
                      </Typography.Title>
                      <Typography.Text type="secondary">
                        {item.tenant.tenantKey} · {item.tenant.tenantName}
                      </Typography.Text>
                    </div>

                    <div className="saas-tenant-card-meta">
                      <div className="saas-tenant-card-meta-item">
                        <span>业务角色</span>
                        <strong>{membershipRoleLabel(item.membership.systemRole)}</strong>
                      </div>
                      <div className="saas-tenant-card-meta-item">
                        <span>最近状态</span>
                        <strong>{tenantStatusLabel(item.tenant.status)}</strong>
                      </div>
                    </div>

                    <Button
                      type="primary"
                      block
                      icon={<ArrowRightOutlined />}
                      loading={selectingTenantId === item.tenant.id}
                      disabled={item.tenant.status !== 'active'}
                      onClick={async () => {
                        setSelectingTenantId(item.tenant.id);
                        try {
                          await selectTenant(item.tenant.id);
                          navigate('/dashboard', { replace: true });
                        } catch (error) {
                          messageApi.error(error instanceof Error ? error.message : '进入租户失败');
                        } finally {
                          setSelectingTenantId(null);
                        }
                      }}
                    >
                      进入租户工作台
                    </Button>
                  </Space>
                </Card>
              </Col>
            ))}
          </Row>
        )}

        <div className="glass-panel saas-note-panel">
          <Space size={12} align="start">
            <BankOutlined style={{ fontSize: 18, color: '#a5b4fc', marginTop: 4 }} />
            <div>
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                进入规则
              </Typography.Title>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                平台会话只用于租户与成员管理；选择租户后会切换为租户作用域会话，之后所有业务请求都只作用于当前租户。
              </Typography.Paragraph>
            </div>
          </Space>
        </div>
      </div>
    </PageContainer>
  );
}
