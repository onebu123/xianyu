import {
  ReloadOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo, useState } from 'react';

import { apiRequest } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { formatNumber } from '../utils';
import { SummaryCards } from '../components/SummaryCards';

interface FakaInventoryResponse {
  list: Array<{
    productId: number | null;
    productName: string | null;
    category: string | null;
    typeId: number;
    typeName: string;
    typeStatus: string;
    unusedCount: number;
    usedCount: number;
  }>;
}

export function FakaPage() {
  const [messageApi, contextHolder] = message.useMessage();

  const [importModalOpen, setImportModalOpen] = useState(false);
  const [activeTypeId, setActiveTypeId] = useState<number | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importForm] = Form.useForm();

  const loader = useCallback(async () => {
    return apiRequest<FakaInventoryResponse>('/api/cards/inventory', undefined);
  }, []);

  const { data, loading, error, reload } = useRemoteData<FakaInventoryResponse>(loader);

  const summary = useMemo(() => {
    if (!data) return [];
    let totalUnused = 0;
    let totalUsed = 0;
    data.list.forEach((item) => {
      totalUnused += item.unusedCount;
      totalUsed += item.usedCount;
    });

    return [
      { key: 'types', label: '受管商品卡种', value: data.list.length, unit: '个' },
      { key: 'unused', label: '待用卡密库存', value: totalUnused, unit: '张' },
      { key: 'used', label: '累计售出卡密', value: totalUsed, unit: '张' },
    ];
  }, [data]);

  const handleOpenImport = useCallback((typeId: number) => {
    setActiveTypeId(typeId);
    importForm.resetFields();
    setImportModalOpen(true);
  }, [importForm]);

  const handleCloseImport = useCallback(() => {
    setImportModalOpen(false);
    setActiveTypeId(null);
  }, []);

  const handleSubmitImport = useCallback(async () => {
    try {
      const values = await importForm.validateFields();
      if (!activeTypeId) return;

      setImportLoading(true);
      const lines = (values.rawText as string)
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);

      const cards = lines.map(line => {
        const parts = line.split(/[,\s|]+/);
        if (parts.length >= 2) {
          return { no: parts[0], secret: parts.slice(1).join(' ') };
        }
        return { no: line, secret: line };
      });

      if (cards.length === 0) {
        messageApi.warning('未解析到有效卡密行');
        return;
      }

      await apiRequest('/api/cards/upload', {
        method: 'POST',
        body: JSON.stringify({
          typeId: activeTypeId,
          cards,
        }),
      });

      messageApi.success(`成功导入 ${cards.length} 张卡密！`);
      handleCloseImport();
      await reload();
    } catch (err) {
      if (err instanceof Error && err.message) {
        messageApi.error(err.message);
      }
    } finally {
      setImportLoading(false);
    }
  }, [activeTypeId, importForm, messageApi, reload, handleCloseImport]);

  const columns = useMemo<TableProps<FakaInventoryResponse['list'][number]>['columns']>(
    () => [
      {
        title: '卡种 ID',
        dataIndex: 'typeId',
        width: 100,
        render: (val: number) => <Typography.Text strong>#{val}</Typography.Text>
      },
      {
        title: '卡种名称',
        dataIndex: 'typeName',
        width: 180,
      },
      {
        title: '关联闲鱼商品',
        dataIndex: 'productName',
        width: 250,
        render: (val: string | null, row) => (
          <div className="product-title-cell">
            <Typography.Text>{val ?? '未绑定商品'}</Typography.Text>
            {row.category && <div className="product-cell-meta">{row.category}</div>}
          </div>
        )
      },
      {
        title: '剩余库存',
        dataIndex: 'unusedCount',
        width: 140,
        sorter: (a, b) => a.unusedCount - b.unusedCount,
        render: (val: number) => (
          <Tag color={val > 10 ? 'success' : val > 0 ? 'warning' : 'error'}>
            {formatNumber(val, ' 张')}
          </Tag>
        )
      },
      {
        title: '已售出',
        dataIndex: 'usedCount',
        width: 120,
        render: (val: number) => formatNumber(val, ' 张')
      },
      {
        title: '状态',
        dataIndex: 'typeStatus',
        width: 100,
        render: (val: string) => (
          <Tag color={val === 'active' ? 'processing' : 'default'}>
            {val === 'active' ? '启用中' : '已停用'}
          </Tag>
        )
      },
      {
        title: '操作',
        key: 'action',
        fixed: 'right',
        width: 120,
        render: (_val, row) => (
          <Button size="small" type="link" onClick={() => handleOpenImport(row.typeId)}>
            导入库存
          </Button>
        )
      }
    ],
    [handleOpenImport]
  );

  return (
    <PageContainer
      title="发卡履约系统"
      subTitle="独立管理虚拟卡密商品的库存。当订单归拍至【卡密发货】通道时，系统将自动化提取此处的可用库存通过 IM 派发并留言出库提取码。"
      style={{ paddingInline: 0 }}
      extra={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>
          刷新状态
        </Button>
      ]}
    >
      {contextHolder}
      <div className="page-grid faka-workbench">
        <Alert
          type="info"
          showIcon
          message="全自动发货流接入说明"
          description="无需人工接入：只要该商品在商品设置中勾选了【标准发货 (Manual / Card)】且配置了对应的卡种 ID，订单落库时自动流经 [卡密抓取 -> IM推送 -> 充单填据] 流程。"
        />

        {error && <Alert type="error" showIcon message={error} />}

        {data && <SummaryCards items={summary} />}

        <Card className="glass-panel" title="发卡品类与库存监控" bordered={false}>
          <Table
            rowKey="typeId"
            loading={loading}
            dataSource={data?.list ?? []}
            columns={columns}
            pagination={{ pageSize: 12 }}
            scroll={{ x: 1050 }}
          />
        </Card>
      </div>

      <Modal
        title="导入卡密库存"
        open={importModalOpen}
        onCancel={handleCloseImport}
        onOk={() => void handleSubmitImport()}
        confirmLoading={importLoading}
        width={560}
      >
        <Alert
          message="卡密解析规则"
          description="系统支持单条文本智能切分。默认按照空格或逗号切分：第一段为卡号，后面的部分自动拼接为密码。如果仅有一段文本，则卡号和密码相同。"
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />
        <Form form={importForm} layout="vertical">
          <Form.Item
            name="rawText"
            label="粘贴卡密数据（每条一行）"
            rules={[{ required: true, message: '请粘贴卡密数据' }]}
          >
            <Input.TextArea
              rows={10}
              placeholder="0123456789 ABCDEFGH-RTYUX\n0123456780 QWERTYUI-OPASD\n..."
            />
          </Form.Item>
        </Form>
      </Modal>

    </PageContainer>
  );
}
