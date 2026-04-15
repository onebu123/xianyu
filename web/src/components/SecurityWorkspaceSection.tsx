import {
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';

import type {
  OpenLogsDetailResponse,
  SystemAccountsDetailResponse,
  SystemConfigsDetailResponse,
  SystemUserRole,
  WorkspaceBusinessMetric,
} from '../api';

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

function roleLabel(role: SystemUserRole) {
  return (
    {
      admin: '管理员',
      operator: '运营',
      support: '客服',
      finance: '财务',
    }[role] ?? role
  );
}

function statusMeta(status: 'active' | 'disabled') {
  return status === 'active'
    ? { text: '启用', color: 'success' }
    : { text: '停用', color: 'default' };
}

function auditMeta(result: string) {
  return (
    {
      success: { text: '成功', color: 'success' },
      failure: { text: '失败', color: 'error' },
      blocked: { text: '拦截', color: 'warning' },
    }[result] ?? { text: result, color: 'default' }
  );
}

const roleOptions = [
  { label: '管理员', value: 'admin' },
  { label: '运营', value: 'operator' },
  { label: '客服', value: 'support' },
  { label: '财务', value: 'finance' },
];

interface SecurityWorkspaceSectionProps {
  detail: SystemAccountsDetailResponse | OpenLogsDetailResponse | SystemConfigsDetailResponse;
  busyKey: string | null;
  canManageUsers: boolean;
  canManageSecureSettings: boolean;
  onCreateSystemUser: (input: {
    username: string;
    displayName: string;
    password: string;
    role: SystemUserRole;
  }) => Promise<void>;
  onUpdateSystemUserRole: (userId: number, role: SystemUserRole) => Promise<void>;
  onUpdateSystemUserStatus: (userId: number, status: 'active' | 'disabled') => Promise<void>;
  onUpdateSecureSetting: (key: string, description: string, value: string) => Promise<void>;
}

export function SecurityWorkspaceSection({
  detail,
  busyKey,
  canManageUsers,
  canManageSecureSettings,
  onCreateSystemUser,
  onUpdateSystemUserRole,
  onUpdateSystemUserStatus,
  onUpdateSecureSetting,
}: SecurityWorkspaceSectionProps) {
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [secureSettingOpen, setSecureSettingOpen] = useState(false);
  const [editingSecureSetting, setEditingSecureSetting] = useState<{
    key: string;
    description: string;
  } | null>(null);
  const [createUserForm] = Form.useForm();
  const [secureSettingForm] = Form.useForm();

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
          {detail.kind === 'system-accounts' && canManageUsers ? (
            <Button
              type="primary"
              onClick={() => {
                createUserForm.resetFields();
                setCreateUserOpen(true);
              }}
            >
              新增账号
            </Button>
          ) : null}
          {detail.kind === 'system-configs' && canManageSecureSettings ? (
            <Button
              type="primary"
              onClick={() => {
                setEditingSecureSetting(null);
                secureSettingForm.resetFields();
                setSecureSettingOpen(true);
              }}
            >
              新增配置
            </Button>
          ) : null}
        </div>
        {renderMetrics(detail.metrics)}
      </div>

      {detail.kind === 'system-accounts' ? (
        <div className="module-panel">
          <Table
            rowKey="id"
            pagination={false}
            size="small"
            scroll={{ x: 1240 }}
            dataSource={detail.rows}
            columns={[
              { title: '用户名', dataIndex: 'username' },
              { title: '显示名', dataIndex: 'displayName' },
              { title: '角色', dataIndex: 'role', render: (value: SystemUserRole) => <Tag color="blue">{roleLabel(value)}</Tag> },
              {
                title: '状态',
                dataIndex: 'status',
                render: (value: 'active' | 'disabled') => {
                  const meta = statusMeta(value);
                  return <Tag color={meta.color}>{meta.text}</Tag>;
                },
              },
              { title: '创建时间', dataIndex: 'createdAt' },
              { title: '更新时间', dataIndex: 'updatedAt' },
              { title: '最近登录', dataIndex: 'lastLoginAt', render: (value: string | null) => value ?? '未登录' },
              {
                title: '操作',
                dataIndex: 'id',
                render: (_: unknown, row) =>
                  canManageUsers ? (
                    <Space wrap>
                      <Select<SystemUserRole>
                        size="small"
                        style={{ width: 108 }}
                        value={row.role}
                        options={roleOptions}
                        loading={busyKey === `user-role-${row.id}`}
                        onChange={(value) => void onUpdateSystemUserRole(row.id, value)}
                      />
                      <Button
                        size="small"
                        loading={busyKey === `user-status-${row.id}`}
                        onClick={() =>
                          void onUpdateSystemUserStatus(
                            row.id,
                            row.status === 'active' ? 'disabled' : 'active',
                          )
                        }
                      >
                        {row.status === 'active' ? '停用' : '启用'}
                      </Button>
                    </Space>
                  ) : (
                    <Tag>只读</Tag>
                  ),
              },
            ]}
          />
        </div>
      ) : null}

      {detail.kind === 'open-logs' ? (
        <div className="module-panel">
          <Table
            rowKey="id"
            pagination={false}
            size="small"
            scroll={{ x: 1320 }}
            dataSource={detail.rows}
            columns={[
              { title: '时间', dataIndex: 'createdAt', width: 180 },
              {
                title: '操作人',
                dataIndex: 'operatorDisplayName',
                render: (_: unknown, row) => row.operatorDisplayName ?? row.operatorUsername ?? '匿名',
              },
              { title: '动作', dataIndex: 'action' },
              {
                title: '目标',
                dataIndex: 'targetType',
                render: (_: unknown, row) => `${row.targetType}${row.targetId ? ` / ${row.targetId}` : ''}`,
              },
              {
                title: '结果',
                dataIndex: 'result',
                render: (value: string) => {
                  const meta = auditMeta(value);
                  return <Tag color={meta.color}>{meta.text}</Tag>;
                },
              },
              { title: '来源 IP', dataIndex: 'ipAddress', render: (value: string | null) => value ?? '-' },
              { title: '详情', dataIndex: 'detail' },
            ]}
          />
        </div>
      ) : null}

      {detail.kind === 'system-configs' ? (
        <div className="module-panel">
          <Table
            rowKey="key"
            pagination={false}
            size="small"
            scroll={{ x: 1120 }}
            dataSource={detail.rows}
            columns={[
              { title: '配置键名', dataIndex: 'key' },
              { title: '用途说明', dataIndex: 'description' },
              { title: '脱敏值', dataIndex: 'maskedValue' },
              { title: '最后更新人', dataIndex: 'updatedByName', render: (value: string | null) => value ?? '系统初始化' },
              { title: '最后更新时间', dataIndex: 'updatedAt' },
              {
                title: '操作',
                dataIndex: 'key',
                render: (_: unknown, row) =>
                  canManageSecureSettings ? (
                    <Button
                      size="small"
                      loading={busyKey === `secure-setting-${row.key}`}
                      onClick={() => {
                        setEditingSecureSetting({ key: row.key, description: row.description });
                        secureSettingForm.setFieldsValue({
                          key: row.key,
                          description: row.description,
                          value: '',
                        });
                        setSecureSettingOpen(true);
                      }}
                    >
                      更新密钥
                    </Button>
                  ) : (
                    <Tag>只读</Tag>
                  ),
              },
            ]}
          />
        </div>
      ) : null}

      <Modal
        title="新增后台账号"
        open={createUserOpen}
        onCancel={() => setCreateUserOpen(false)}
        onOk={() => void createUserForm.submit()}
        confirmLoading={busyKey === 'create-user'}
        destroyOnClose
      >
        <Form
          form={createUserForm}
          layout="vertical"
          onFinish={async (values) => {
            await onCreateSystemUser(values);
            setCreateUserOpen(false);
          }}
        >
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="如 operator_02" />
          </Form.Item>
          <Form.Item label="显示名" name="displayName" rules={[{ required: true, message: '请输入显示名' }]}>
            <Input placeholder="如 华东运营" />
          </Form.Item>
          <Form.Item label="登录密码" name="password" rules={[{ required: true, message: '请输入登录密码' }]}>
            <Input.Password placeholder="至少 8 位" />
          </Form.Item>
          <Form.Item label="角色" name="role" rules={[{ required: true, message: '请选择角色' }]}>
            <Select options={roleOptions} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editingSecureSetting ? `更新配置 ${editingSecureSetting.key}` : '新增敏感配置'}
        open={secureSettingOpen}
        onCancel={() => setSecureSettingOpen(false)}
        onOk={() => void secureSettingForm.submit()}
        confirmLoading={
          busyKey === 'create-secure-setting' ||
          (editingSecureSetting ? busyKey === `secure-setting-${editingSecureSetting.key}` : false)
        }
        destroyOnClose
      >
        <Form
          form={secureSettingForm}
          layout="vertical"
          initialValues={editingSecureSetting ?? undefined}
          onFinish={async (values) => {
            await onUpdateSecureSetting(values.key, values.description, values.value);
            setSecureSettingOpen(false);
          }}
        >
          <Form.Item label="配置键名" name="key" rules={[{ required: true, message: '请输入配置键名' }]}>
            <Input disabled={Boolean(editingSecureSetting)} placeholder="如 openai_api_key" />
          </Form.Item>
          <Form.Item label="用途说明" name="description" rules={[{ required: true, message: '请输入用途说明' }]}>
            <Input placeholder="说明这项密钥的用途" />
          </Form.Item>
          <Form.Item
            label="明文值"
            name="value"
            rules={[{ required: true, message: '请输入新的明文值' }]}
            extra="提交后只会保存加密密文，页面仍只展示脱敏值。"
          >
            <Input.Password placeholder="输入新的密钥或令牌" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
