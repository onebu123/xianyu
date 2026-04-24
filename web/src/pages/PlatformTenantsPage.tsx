import {
  ApartmentOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  Button,
  Col,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { apiRequest } from '../api';
import type {
  PlatformProvisioningJobListResponse,
  PlatformTenantCreateResponse,
  PlatformTenantListResponse,
  PlatformTenantMembershipListResponse,
  PlatformUserListResponse,
  TenantMembership,
  TenantSummary,
} from '../api';
import { useRemoteData } from '../hooks/useRemoteData';

interface PlatformTenantsData {
  tenants: PlatformTenantListResponse;
  users: PlatformUserListResponse;
  jobs: PlatformProvisioningJobListResponse;
}

function tenantStatusColor(status: TenantSummary['status']) {
  return (
    {
      active: 'success',
      provisioning: 'processing',
      suspended: 'warning',
    }[status] ?? 'default'
  );
}

function tenantStatusLabel(status: TenantSummary['status']) {
  return (
    {
      active: '运行中',
      provisioning: '开通中',
      suspended: '已暂停',
    }[status] ?? status
  );
}

function membershipRoleLabel(role: TenantMembership['membershipRole']) {
  return (
    {
      owner: '所有者',
      admin: '管理员',
      member: '成员',
      support: '客服',
    }[role] ?? role
  );
}

export function PlatformTenantsPage() {
  const navigate = useNavigate();
  const [messageApi, contextHolder] = message.useMessage();
  const [createOpen, setCreateOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [busyTenantId, setBusyTenantId] = useState<number | null>(null);
  const [selectedTenant, setSelectedTenant] = useState<TenantSummary | null>(null);
  const [membershipData, setMembershipData] = useState<PlatformTenantMembershipListResponse | null>(null);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [createForm] = Form.useForm();
  const [memberForm] = Form.useForm();

  const loader = useCallback(async () => {
    const [tenants, users, jobs] = await Promise.all([
      apiRequest<PlatformTenantListResponse>('/api/platform/tenants', undefined),
      apiRequest<PlatformUserListResponse>('/api/platform/users', undefined),
      apiRequest<PlatformProvisioningJobListResponse>('/api/platform/provisioning-jobs', undefined),
    ]);
    return { tenants, users, jobs } as PlatformTenantsData;
  }, []);

  const { data, loading, error, reload } = useRemoteData<PlatformTenantsData>(loader);

  const stats = useMemo(() => {
    const list = data?.tenants.list ?? [];
    return {
      total: list.length,
      active: list.filter((item) => item.status === 'active').length,
      provisioning: list.filter((item) => item.status === 'provisioning').length,
      suspended: list.filter((item) => item.status === 'suspended').length,
    };
  }, [data]);

  const openMembershipDrawer = useCallback(async (tenant: TenantSummary) => {
    setSelectedTenant(tenant);
    setDrawerOpen(true);
    setMembershipLoading(true);
    try {
      const payload = await apiRequest<PlatformTenantMembershipListResponse>(
        `/api/platform/tenants/${tenant.id}/memberships`,
        undefined,
      );
      setMembershipData(payload);
    } catch (requestError) {
      messageApi.error(requestError instanceof Error ? requestError.message : '加载租户成员失败');
    } finally {
      setMembershipLoading(false);
    }
  }, [messageApi]);

  const tenantColumns = useMemo<TableProps<TenantSummary>['columns']>(
    () => [
      {
        title: '租户',
        dataIndex: 'displayName',
        render: (_, tenant) => (
          <div>
            <Typography.Text strong>{tenant.displayName}</Typography.Text>
            <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>
              {tenant.tenantKey} · {tenant.tenantName}
            </div>
          </div>
        ),
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: 120,
        render: (value: TenantSummary['status']) => (
          <Tag color={tenantStatusColor(value)}>{tenantStatusLabel(value)}</Tag>
        ),
      },
      {
        title: '开通时间',
        dataIndex: 'provisionedAt',
        width: 180,
        render: (value: string | null) => value ?? '-',
      },
      {
        title: '数据库',
        dataIndex: 'businessDbPath',
        render: (value: string) => (
          <Typography.Text ellipsis style={{ maxWidth: 280 }}>
            {value}
          </Typography.Text>
        ),
      },
      {
        title: '操作',
        key: 'actions',
        width: 260,
        render: (_, tenant) => (
          <Space wrap>
            <Button size="small" onClick={() => void openMembershipDrawer(tenant)}>
              成员
            </Button>
            <Button
              size="small"
              onClick={() => navigate('/platform/provisioning-jobs')}
            >
              开通任务
            </Button>
            <Button
              size="small"
              loading={busyTenantId === tenant.id}
              onClick={async () => {
                setBusyTenantId(tenant.id);
                try {
                  await apiRequest('/api/auth/select-tenant', {
                    method: 'POST',
                    body: JSON.stringify({ tenantId: tenant.id }),
                  });
                  navigate('/dashboard', { replace: true });
                } catch (requestError) {
                  messageApi.error(requestError instanceof Error ? requestError.message : '进入租户失败');
                } finally {
                  setBusyTenantId(null);
                }
              }}
            >
              进入租户
            </Button>
            <Button
              size="small"
              loading={busyTenantId === -tenant.id}
              onClick={async () => {
                setBusyTenantId(-tenant.id);
                try {
                  await apiRequest(`/api/platform/tenants/${tenant.id}/status`, {
                    method: 'POST',
                    body: JSON.stringify({
                      status: tenant.status === 'suspended' ? 'active' : 'suspended',
                    }),
                  });
                  messageApi.success('租户状态已更新');
                  await reload();
                } catch (requestError) {
                  messageApi.error(requestError instanceof Error ? requestError.message : '更新租户状态失败');
                } finally {
                  setBusyTenantId(null);
                }
              }}
            >
              {tenant.status === 'suspended' ? '恢复' : '暂停'}
            </Button>
          </Space>
        ),
      },
    ],
    [busyTenantId, messageApi, navigate, openMembershipDrawer, reload],
  );

  const membershipColumns = useMemo<TableProps<PlatformTenantMembershipListResponse['list'][number]>['columns']>(
    () => [
      {
        title: '平台账号',
        key: 'user',
        render: (_, row) => (
          <div>
            <Typography.Text strong>{row.user.displayName}</Typography.Text>
            <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>
              {row.user.username}
            </div>
          </div>
        ),
      },
      {
        title: '成员角色',
        dataIndex: ['membership', 'membershipRole'],
        width: 120,
        render: (value: TenantMembership['membershipRole']) => membershipRoleLabel(value),
      },
      {
        title: '业务角色',
        dataIndex: ['membership', 'systemRole'],
        width: 120,
      },
      {
        title: '状态',
        dataIndex: ['membership', 'status'],
        width: 100,
        render: (value: string) => <Tag color={value === 'active' ? 'success' : 'default'}>{value === 'active' ? '启用' : '停用'}</Tag>,
      },
    ],
    [],
  );

  return (
    <PageContainer
      title="租户管理"
      subTitle="管理 SaaS 租户生命周期、成员关系和进入租户工作台的入口。"
      style={{ paddingInline: 0 }}
      extra={[
        <Button key="reload" icon={<ReloadOutlined />} onClick={() => void reload()}>
          刷新
        </Button>,
        <Button key="create" type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          创建租户
        </Button>,
      ]}
    >
      {contextHolder}
      <div className="page-grid">
        <Alert
          type="info"
          showIcon
          icon={<ApartmentOutlined />}
          message="控制面说明"
          description="当前页面用于管理企业租户、成员关系和租户生命周期。租户创建完成后可直接进入对应业务工作台。"
        />

        {error ? <Alert type="error" showIcon message={error} /> : null}

        <Row gutter={[16, 16]}>
          <Col xs={24} md={12} xl={6}>
            <div className="glass-panel">
              <Statistic title="租户总数" value={stats.total} />
            </div>
          </Col>
          <Col xs={24} md={12} xl={6}>
            <div className="glass-panel">
              <Statistic title="运行中" value={stats.active} valueStyle={{ color: '#22c55e' }} />
            </div>
          </Col>
          <Col xs={24} md={12} xl={6}>
            <div className="glass-panel">
              <Statistic title="开通中" value={stats.provisioning} valueStyle={{ color: '#60a5fa' }} />
            </div>
          </Col>
          <Col xs={24} md={12} xl={6}>
            <div className="glass-panel">
              <Statistic title="已暂停" value={stats.suspended} valueStyle={{ color: '#f59e0b' }} />
            </div>
          </Col>
        </Row>

        <div className="glass-panel" style={{ padding: 24 }}>
          <Table
            rowKey="id"
            loading={loading}
            dataSource={data?.tenants.list ?? []}
            columns={tenantColumns}
            pagination={{ pageSize: 8 }}
          />
        </div>
      </div>

      <Modal
        title="创建租户"
        open={createOpen}
        onCancel={() => {
          setCreateOpen(false);
          createForm.resetFields();
        }}
        onOk={() => void createForm.submit()}
        confirmLoading={submitting}
        width={560}
      >
        <Form
          form={createForm}
          layout="vertical"
          onFinish={async (values) => {
            setSubmitting(true);
            try {
              const payload = await apiRequest<PlatformTenantCreateResponse>('/api/platform/tenants', {
                method: 'POST',
                body: JSON.stringify(values),
              });
              messageApi.success(
                payload.provisioningJob?.status === 'succeeded'
                  ? '租户已创建并完成开通'
                  : '租户已创建，正在执行开通任务',
              );
              setCreateOpen(false);
              createForm.resetFields();
              await reload();
            } catch (requestError) {
              messageApi.error(requestError instanceof Error ? requestError.message : '创建租户失败');
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <Form.Item label="租户标识" name="tenantKey" rules={[{ required: true, message: '请输入租户标识' }]}>
            <Input placeholder="例如 acme-corp" />
          </Form.Item>
          <Form.Item label="租户名称" name="tenantName" rules={[{ required: true, message: '请输入租户名称' }]}>
            <Input placeholder="例如 Acme Corp" />
          </Form.Item>
          <Form.Item label="展示名称" name="displayName">
            <Input placeholder="默认与租户名称一致" />
          </Form.Item>
          <Form.Item label="初始管理员" name="initialAdminUserId">
            <Select
              allowClear
              showSearch
              placeholder="默认使用当前平台管理员"
              optionFilterProp="label"
              options={(data?.users.list ?? []).map((user) => ({
                value: user.id,
                label: `${user.displayName} · ${user.username}`,
              }))}
            />
          </Form.Item>
          <Form.Item label="初始业务角色" name="initialAdminRole" initialValue="admin">
            <Select
              options={[
                { value: 'admin', label: '管理员' },
                { value: 'operator', label: '运营' },
                { value: 'support', label: '客服' },
                { value: 'finance', label: '财务' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        width={560}
        title={selectedTenant ? `${selectedTenant.displayName} · 成员管理` : '成员管理'}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setMembershipData(null);
          memberForm.resetFields();
        }}
      >
        {selectedTenant ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions
              bordered
              size="small"
              column={1}
              items={[
                { key: 'tenantKey', label: '租户标识', children: selectedTenant.tenantKey },
                { key: 'status', label: '租户状态', children: tenantStatusLabel(selectedTenant.status) },
                { key: 'db', label: '业务数据库', children: selectedTenant.businessDbPath },
              ]}
            />

            <div className="glass-panel">
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                新增或更新成员
              </Typography.Title>
              <Form
                form={memberForm}
                layout="vertical"
                onFinish={async (values) => {
                  if (!selectedTenant) {
                    return;
                  }
                  setSubmitting(true);
                  try {
                    await apiRequest(`/api/platform/tenants/${selectedTenant.id}/memberships`, {
                      method: 'POST',
                      body: JSON.stringify(values),
                    });
                    messageApi.success('租户成员关系已更新');
                    const payload = await apiRequest<PlatformTenantMembershipListResponse>(
                      `/api/platform/tenants/${selectedTenant.id}/memberships`,
                      undefined,
                    );
                    setMembershipData(payload);
                    memberForm.resetFields();
                  } catch (requestError) {
                    messageApi.error(requestError instanceof Error ? requestError.message : '更新成员失败');
                  } finally {
                    setSubmitting(false);
                  }
                }}
              >
                <Form.Item
                  label="平台账号"
                  name="platformUserId"
                  rules={[{ required: true, message: '请选择平台账号' }]}
                >
                  <Select
                    showSearch
                    optionFilterProp="label"
                    options={(data?.users.list ?? []).map((user) => ({
                      value: user.id,
                      label: `${user.displayName} · ${user.username}`,
                    }))}
                  />
                </Form.Item>
                <Form.Item label="成员角色" name="membershipRole" initialValue="member">
                  <Select
                    options={[
                      { value: 'owner', label: '所有者' },
                      { value: 'admin', label: '管理员' },
                      { value: 'member', label: '成员' },
                      { value: 'support', label: '客服' },
                    ]}
                  />
                </Form.Item>
                <Form.Item label="业务角色" name="systemRole" initialValue="operator">
                  <Select
                    options={[
                      { value: 'admin', label: '管理员' },
                      { value: 'operator', label: '运营' },
                      { value: 'support', label: '客服' },
                      { value: 'finance', label: '财务' },
                    ]}
                  />
                </Form.Item>
                <Form.Item label="状态" name="status" initialValue="active">
                  <Select
                    options={[
                      { value: 'active', label: '启用' },
                      { value: 'disabled', label: '停用' },
                    ]}
                  />
                </Form.Item>
                <Button type="primary" htmlType="submit" loading={submitting} icon={<TeamOutlined />}>
                  保存成员关系
                </Button>
              </Form>
            </div>

            <div className="glass-panel">
              <Space align="center" style={{ marginBottom: 16 }}>
                <SafetyCertificateOutlined style={{ color: '#a5b4fc' }} />
                <Typography.Title level={5} style={{ margin: 0 }}>
                  当前成员
                </Typography.Title>
              </Space>
              <Table
                rowKey={(row) => row.membership.id}
                loading={membershipLoading}
                dataSource={membershipData?.list ?? []}
                columns={membershipColumns}
                pagination={false}
              />
            </div>
          </Space>
        ) : null}
      </Drawer>
    </PageContainer>
  );
}
