import {
  CopyOutlined,
  DeploymentUnitOutlined,
  ExportOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  ShopOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  Avatar,
  Button,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import type { TableProps, TabsProps } from 'antd';
import dayjs from 'dayjs';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  type DashboardResponse,
  type FilterQuery,
  type ProductsResponse,
  type XianyuProductSyncResponse,
  apiRequest,
  buildQuery,
} from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { formatCurrency, formatNumber } from '../utils';

type ProductTabKey =
  | 'all'
  | 'draft'
  | 'pending'
  | 'processing'
  | 'onSale'
  | 'auction'
  | 'manualOff'
  | 'autoOff'
  | 'soldOut'
  | 'auctionOff'
  | 'actions';

type ProductTypeFilter = 'all' | 'virtual' | 'physical';

interface ProductsPageData {
  options: DashboardResponse['filters'];
  products: ProductsResponse;
}

type FulfillmentType = 'standard' | 'direct_charge' | 'source_system';

interface FulfillmentAdapterOption {
  key: string;
  label: string;
}

interface FulfillmentAdaptersResponse {
  directChargeAdapters: FulfillmentAdapterOption[];
  sourceSystemAdapters: FulfillmentAdapterOption[];
}

interface ProductFulfillmentRuleResponse {
  productId: number;
  fulfillmentType: FulfillmentType;
  supplierId: string | null;
  externalSku: string | null;
}

interface FulfillmentRuleFormValues {
  fulfillmentType: FulfillmentType;
  supplierId?: string;
  externalSku?: string;
}

type ProductWorkbenchRow = ProductsResponse['ranking'][number] & {
  productType: Exclude<ProductTypeFilter, 'all'>;
  productTypeLabel: string;
  statusKey: 'onSale' | 'processing' | 'soldOut';
  statusLabel: string;
  statusColor: string;
  lowStock: boolean;
};

const productTabs: Array<{ key: ProductTabKey; label: string }> = [
  { key: 'all', label: '所有商品' },
  { key: 'draft', label: '草稿箱' },
  { key: 'pending', label: '待发布' },
  { key: 'processing', label: '处理中' },
  { key: 'onSale', label: '销售中' },
  { key: 'auction', label: '拍卖中' },
  { key: 'manualOff', label: '手动下架' },
  { key: 'autoOff', label: '自动下架' },
  { key: 'soldOut', label: '售出下架' },
  { key: 'auctionOff', label: '拍卖下架' },
  { key: 'actions', label: '功能操作' },
];

function inferProductType(category: string) {
  const virtualKeywords = ['充值', '会员', '点券', '卡', '直充', '券'];
  const isVirtual = virtualKeywords.some((keyword) => category.includes(keyword));
  return {
    key: isVirtual ? 'virtual' : 'physical',
    label: isVirtual ? '虚拟商品' : '闲鱼现货',
  } as const;
}

function buildProductStatus(row: ProductsResponse['ranking'][number]) {
  if (row.stock <= 0) {
    return { key: 'soldOut', label: '售出下架', color: 'default' } as const;
  }
  if (row.afterSaleCount > 0) {
    return { key: 'processing', label: '处理中', color: 'processing' } as const;
  }
  return { key: 'onSale', label: '销售中', color: 'success' } as const;
}

function formatProductTime(value: string | null) {
  if (!value) {
    return '暂无记录';
  }
  return dayjs(value).format('YYYY-MM-DD HH:mm');
}

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

function normalizeBatchKeywords(input: string) {
  return Array.from(
    new Set(
      input
        .split(/[\r\n,，]+/)
        .map((keyword) => keyword.trim())
        .filter(Boolean),
    ),
  );
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

export function ProductsPage() {
  const navigate = useNavigate();
  const [messageApi, contextHolder] = message.useMessage();
  const [filters, setFilters] = useState<FilterQuery>({ preset: 'last30Days' });
  const [activeTab, setActiveTab] = useState<ProductTabKey>('onSale');
  const [productTypeFilter, setProductTypeFilter] = useState<ProductTypeFilter>('all');
  const [ruleOpen, setRuleOpen] = useState<number | null>(null);
  const [adapters, setAdapters] = useState<FulfillmentAdaptersResponse | null>(null);
  const [ruleLoading, setRuleLoading] = useState(false);
  const [ruleForm] = Form.useForm<FulfillmentRuleFormValues>();
  const [detailOpen, setDetailOpen] = useState<number | null>(null);
  const [batchSearchOpen, setBatchSearchOpen] = useState(false);
  const [batchSearchText, setBatchSearchText] = useState('');
  const [batchKeywords, setBatchKeywords] = useState<string[]>([]);
  const [publishGuideOpen, setPublishGuideOpen] = useState(false);
  const queryString = useMemo(() => buildQuery(filters), [filters]);

  const loader = useCallback(async () => {
    const [options, products] = await Promise.all([
      apiRequest<DashboardResponse['filters']>('/api/options', undefined),
      apiRequest<ProductsResponse>(`/api/products?${queryString}`, undefined),
    ]);
    return { options, products };
  }, [queryString]);

  const { data, loading, error, reload } = useRemoteData<ProductsPageData>(loader);

  const productRows = useMemo<ProductWorkbenchRow[]>(() => {
    return (data?.products.ranking ?? []).map((item) => {
      const productType = inferProductType(item.category);
      const status = buildProductStatus(item);
      return {
        ...item,
        productType: productType.key,
        productTypeLabel: productType.label,
        statusKey: status.key,
        statusLabel: status.label,
        statusColor: status.color,
        lowStock: item.stock <= 30,
      };
    });
  }, [data]);

  const filteredRows = useMemo(() => {
    let rows = productRows;

    if (productTypeFilter !== 'all') {
      rows = rows.filter((row) => row.productType === productTypeFilter);
    }

    if (batchKeywords.length > 0) {
      rows = rows.filter((row) => {
        const haystack = `${row.name} ${row.sku}`.toLowerCase();
        return batchKeywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
      });
    }

    switch (activeTab) {
      case 'processing':
        return rows.filter((row) => row.statusKey === 'processing');
      case 'onSale':
        return rows.filter((row) => row.statusKey === 'onSale');
      case 'soldOut':
        return rows.filter((row) => row.statusKey === 'soldOut');
      case 'all':
        return rows;
      case 'actions':
        return rows;
      default:
        return [];
    }
  }, [activeTab, batchKeywords, productRows, productTypeFilter]);

  const overallProductCount = data?.products.summary.totalProducts ?? productRows.length;

  const statusCounts = useMemo(
    () => ({
      all: productRows.length,
      processing: productRows.filter((row) => row.statusKey === 'processing').length,
      onSale: productRows.filter((row) => row.statusKey === 'onSale').length,
      soldOut: productRows.filter((row) => row.statusKey === 'soldOut').length,
    }),
    [productRows],
  );

  const summaryCards = useMemo(
    () => [
      {
        key: 'total',
        label: '当前列表商品',
        value: statusCounts.all,
        helper: `筛选范围共 ${formatNumber(overallProductCount)} 款商品`,
      },
      {
        key: 'onSale',
        label: '销售中',
        value: statusCounts.onSale,
        helper: '可继续承接订单的商品',
      },
      {
        key: 'processing',
        label: '处理中',
        value: statusCounts.processing,
        helper: '存在售后或异常需要跟进',
      },
      {
        key: 'stock',
        label: '在售库存数',
        value: data?.products.summary.totalStock ?? 0,
        helper: '已聚合当前筛选范围库存',
      },
      {
        key: 'sales',
        label: '近 30 天销量',
        value: data?.products.summary.soldQuantity ?? 0,
        helper: '用于判断动销和补货节奏',
      },
      {
        key: 'gmv',
        label: '近 30 天销售额',
        value: data?.products.summary.salesAmount ?? 0,
        helper: '按订单口径回收成交金额',
      },
    ],
    [data, overallProductCount, statusCounts],
  );

  const storeIdByName = useMemo(
    () => new Map((data?.options.stores ?? []).map((item) => [item.label, item.value])),
    [data?.options.stores],
  );

  const detailRow = useMemo(
    () => productRows.find((row) => row.id === detailOpen) ?? null,
    [detailOpen, productRows],
  );

  const tabItems = useMemo<TabsProps['items']>(
    () =>
      productTabs.map((tab) => {
        const countMap: Record<ProductTabKey, number | string> = {
          all: statusCounts.all,
          draft: 0,
          pending: 0,
          processing: statusCounts.processing,
          onSale: statusCounts.onSale,
          auction: 0,
          manualOff: 0,
          autoOff: 0,
          soldOut: statusCounts.soldOut,
          auctionOff: 0,
          actions: '入口',
        };

        return {
          key: tab.key,
          label: (
            <span className="product-tab-pill">
              {tab.label}
              <strong>{countMap[tab.key]}</strong>
            </span>
          ),
        };
      }),
    [statusCounts],
  );

  const handleReset = useCallback(() => {
    setFilters({ preset: 'last30Days' });
    setProductTypeFilter('all');
    setActiveTab('onSale');
    setBatchKeywords([]);
    setBatchSearchText('');
  }, []);

  const handleExport = useCallback(() => {
    if (filteredRows.length === 0) {
      messageApi.warning('当前筛选结果为空，暂无可导出的商品。');
      return;
    }

    const header = [
      '商品ID',
      '商家编码',
      '商品标题',
      '状态',
      '分类',
      '商品类型',
      '售价',
      '库存',
      '销量',
      '销售额',
      '店铺',
      '上架时间',
      '最后操作时间',
    ];

    const body = filteredRows.map((row) => [
      row.id,
      row.sku,
      row.name,
      row.statusLabel,
      row.category,
      row.productTypeLabel,
      row.price.toFixed(2),
      row.stock,
      row.soldQuantity,
      row.salesAmount.toFixed(2),
      row.storeName,
      row.firstSaleAt ?? '',
      row.latestSaleAt ?? '',
    ]);

    const csv = [header, ...body]
      .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    downloadTextFile(`products-${dayjs().format('YYYYMMDD-HHmmss')}.csv`, `\uFEFF${csv}`);
    messageApi.success(`已导出 ${filteredRows.length} 条商品记录。`);
  }, [filteredRows, messageApi]);

  const handleSyncProducts = useCallback(async () => {
    try {
      const payload = await apiRequest<XianyuProductSyncResponse>(
        '/api/products/xianyu-web-sync',
        {
          method: 'POST',
          body: JSON.stringify({
            storeIds: filters.storeId ? [filters.storeId] : undefined,
          }),
        },
      );
      const successStores = payload.results.filter((item) => item.success);
      const syncedProducts = successStores.reduce((sum, item) => sum + (item.syncedCount ?? 0), 0);
      setActiveTab('all');
      await reload();
      messageApi.success(
        successStores.length > 0
          ? `已完成 ${successStores.length} 家店铺商品同步，共写入 ${syncedProducts} 条商品。`
          : '同步任务已执行，但没有成功店铺。',
      );
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : '同步闲鱼商品失败');
    }
  }, [filters.storeId, messageApi, reload]);

  const handleOpenDetail = useCallback((productId: number) => {
    setDetailOpen(productId);
  }, []);

  const handleCopySummary = useCallback(
    async (row: ProductWorkbenchRow) => {
      const summary = [
        `商品名称：${row.name}`,
        `商品 ID：${row.id}`,
        `商家编码：${row.sku}`,
        `店铺：${row.storeName}`,
        `分类：${row.category}`,
        `商品类型：${row.productTypeLabel}`,
        `当前状态：${row.statusLabel}`,
        `售价：${formatCurrency(row.price)}`,
        `库存：${formatNumber(row.stock, ' 件')}`,
        `销量：${formatNumber(row.soldQuantity, ' 件')}`,
        `销售额：${formatCurrency(row.salesAmount)}`,
      ].join('\n');

      try {
        await copyText(summary);
        messageApi.success(`已复制 ${row.name} 的商品摘要`);
      } catch {
        messageApi.error('复制商品摘要失败，请手动重试');
      }
    },
    [messageApi],
  );

  const handleFilterByStore = useCallback(
    (row: ProductWorkbenchRow) => {
      const matchedStoreId = storeIdByName.get(row.storeName);
      if (!matchedStoreId) {
        messageApi.warning(`未匹配到 ${row.storeName} 的店铺筛选项`);
        return;
      }

      setFilters((current) => ({
        ...current,
        storeId: matchedStoreId,
      }));
      setActiveTab('all');
      messageApi.success(`已切换到 ${row.storeName} 的商品筛选`);
    },
    [messageApi, storeIdByName],
  );

  const handleApplyBatchSearch = useCallback(() => {
    const keywords = normalizeBatchKeywords(batchSearchText);
    if (keywords.length === 0) {
      messageApi.warning('请至少输入一个商品标题或商家编码');
      return;
    }

    setBatchKeywords(keywords);
    setActiveTab('all');
    setBatchSearchOpen(false);
    messageApi.success(`已应用 ${keywords.length} 个批量搜索关键词`);
  }, [batchSearchText, messageApi]);

  const handleOpenPublishGuide = useCallback(() => {
    setPublishGuideOpen(true);
  }, []);

  const handleOpenRule = useCallback(async (productId: number) => {
    setRuleOpen(productId);
    setRuleLoading(true);
    try {
      let currentAdapters = adapters;
      if (!currentAdapters) {
        currentAdapters = await apiRequest<FulfillmentAdaptersResponse>(
          '/api/fulfillment/adapters',
          undefined,
        );
        setAdapters(currentAdapters);
      }
      const rule = await apiRequest<ProductFulfillmentRuleResponse>(
        `/api/products/${productId}/fulfillment-rule`,
        undefined,
      );
      ruleForm.setFieldsValue({
        fulfillmentType: rule.fulfillmentType || 'standard',
        supplierId: rule.supplierId ?? undefined,
        externalSku: rule.externalSku ?? undefined,
      });
    } catch {
      messageApi.error('加载发货规则失败');
    } finally {
      setRuleLoading(false);
    }
  }, [adapters, messageApi, ruleForm]);

  const handleSaveRule = useCallback(async () => {
    if (ruleOpen === null) {
      messageApi.warning('璇峰厛閫夋嫨闇€瑕侀厤缃殑鍟嗗搧');
      return;
    }

    try {
      const values = await ruleForm.validateFields();
      await apiRequest(
        `/api/products/${ruleOpen}/fulfillment-rule`,
        {
          method: 'POST',
          body: JSON.stringify(values),
        },
      );
      messageApi.success('发货配置保存成功');
      setRuleOpen(null);
    } catch (err) {
      if (err instanceof Error && err.message) {
        messageApi.error(err.message);
      }
    }
  }, [messageApi, ruleForm, ruleOpen]);

  const productColumns = useMemo<TableProps<ProductWorkbenchRow>['columns']>(
    () => [
      {
        title: '闲鱼商品 ID',
        dataIndex: 'id',
        width: 120,
        render: (value: number) => <Typography.Text strong>{value}</Typography.Text>,
      },
      {
        title: '图片',
        dataIndex: 'name',
        width: 88,
        render: (value: string, row) => (
          <Avatar className="product-cover-avatar" style={{ backgroundColor: row.productType === 'virtual' ? '#d75b2a' : '#2f6b5b' }}>
            {value.slice(0, 1)}
          </Avatar>
        ),
      },
      {
        title: '标题',
        dataIndex: 'name',
        width: 280,
        render: (value: string, row) => (
          <div className="product-title-cell">
            <Typography.Text strong>{value}</Typography.Text>
            <div className="product-cell-meta">商家编码：{row.sku}</div>
            <div className="product-cell-meta">最近成交：{formatProductTime(row.latestSaleAt)}</div>
          </div>
        ),
      },
      {
        title: '状态',
        dataIndex: 'statusLabel',
        width: 180,
        render: (_value, row) => (
          <div className="product-status-stack">
            <Space wrap>
              <Tag color={row.statusColor}>{row.statusLabel}</Tag>
              {row.lowStock ? <Tag color="warning">低库存</Tag> : null}
              {row.afterSaleCount > 0 ? <Tag color="processing">售后 {row.afterSaleCount}</Tag> : null}
            </Space>
            <div className="product-cell-meta">
              订单 {formatNumber(row.orderCount, ' 单')} · 销量 {formatNumber(row.soldQuantity, ' 件')}
            </div>
          </div>
        ),
      },
      {
        title: '分类',
        dataIndex: 'category',
        width: 180,
        render: (value: string, row) => (
          <div className="product-title-cell">
            <Tag>{value}</Tag>
            <div className="product-cell-meta">{row.productTypeLabel}</div>
          </div>
        ),
      },
      {
        title: '售价',
        dataIndex: 'price',
        width: 140,
        render: (value: number) => formatCurrency(value),
      },
      {
        title: '库存',
        dataIndex: 'stock',
        width: 110,
        render: (value: number) => formatNumber(value, ' 件'),
      },
      {
        title: '销量',
        dataIndex: 'soldQuantity',
        width: 110,
        render: (value: number) => formatNumber(value, ' 件'),
      },
      {
        title: '店铺',
        dataIndex: 'storeName',
        width: 160,
      },
      {
        title: '商品类型',
        dataIndex: 'productTypeLabel',
        width: 130,
      },
      {
        title: '上架时间',
        dataIndex: 'firstSaleAt',
        width: 170,
        render: (value: string | null) => formatProductTime(value),
      },
      {
        title: '最后操作时间',
        dataIndex: 'latestSaleAt',
        width: 170,
        render: (value: string | null) => formatProductTime(value),
      },
      {
        title: '操作',
        key: 'actions',
        fixed: 'right',
        width: 240,
        render: (_value, row) => (
          <Space size={4} wrap>
            <Button
              size="small"
              type="link"
              onClick={() => void handleOpenRule(row.id)}
            >
              履约配置
            </Button>
            <Button
              size="small"
              type="link"
              onClick={() => handleOpenDetail(row.id)}
            >
              查看概览
            </Button>
            <Button
              size="small"
              type="link"
              onClick={() => void handleCopySummary(row)}
            >
              复制摘要
            </Button>
            <Button
              size="small"
              type="link"
              onClick={() => handleFilterByStore(row)}
            >
              同店筛选
            </Button>
          </Space>
        ),
      },
    ],
    [handleCopySummary, handleFilterByStore, handleOpenDetail, handleOpenRule],
  );

  return (
    <PageContainer
      title="商品工作台"
      subTitle="按 goofish.pro 的商品页形态重做为管理台，优先保留销售中、处理中和功能操作三类链路。"
      style={{ paddingInline: 0 }}
    >
      {contextHolder}
      <div className="page-grid product-workbench">
        {error ? <Alert type="error" showIcon message={error} /> : null}

        {data ? (
          <div className="product-hero glass-panel">
            <div>
              <Tag color="gold">销售中商品</Tag>
              <Typography.Title level={2} style={{ marginTop: 12, marginBottom: 8 }}>
                商品管理
              </Typography.Title>
              <Typography.Paragraph style={{ marginBottom: 0 }}>
                对齐目标站的二级状态栏、筛选区和操作台，当前演示库重点还原销售中商品管理、批量操作入口和商品履约视图。
              </Typography.Paragraph>
            </div>

            <div className="product-summary-grid">
              {summaryCards.map((card) => (
                <div key={card.key} className="product-summary-card">
                  <div className="product-summary-label">{card.label}</div>
                  <div className="product-summary-value">
                    {card.label.includes('销售额')
                      ? formatCurrency(card.value)
                      : formatNumber(card.value)}
                  </div>
                  <div className="product-summary-helper">{card.helper}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <Alert
          type="info"
          showIcon
          message="真实数据同步"
          description={'点击工具栏"同步商品"按钮，系统将通过已绑定的闲鱼登录态从平台拉取真实商品数据并写入本地库。首次同步可能需要几秒钟。'}
        />

        <div className="glass-panel product-filter-shell">
          <div className="product-filter-grid">
            <div className="product-filter-field">
              <span className="product-filter-label">店铺</span>
              <Select
                allowClear
                placeholder="全部店铺"
                options={data?.options.stores ?? []}
                value={filters.storeId}
                onChange={(value) => setFilters((current) => ({ ...current, storeId: value }))}
              />
            </div>
            <div className="product-filter-field">
              <span className="product-filter-label">商品标题 / 商家编码</span>
              <Input
                allowClear
                placeholder="搜索商品标题、商品编号"
                value={filters.keyword}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, keyword: event.target.value }))
                }
              />
            </div>
            <div className="product-filter-field">
              <span className="product-filter-label">分类</span>
              <Select
                allowClear
                placeholder="全部分类"
                options={data?.options.categories ?? []}
                value={filters.category}
                onChange={(value) => setFilters((current) => ({ ...current, category: value }))}
              />
            </div>
            <div className="product-filter-field">
              <span className="product-filter-label">来源</span>
              <Select
                allowClear
                placeholder="全部来源"
                options={data?.options.sources ?? []}
                value={filters.source}
                onChange={(value) => setFilters((current) => ({ ...current, source: value }))}
              />
            </div>
            <div className="product-filter-field">
              <span className="product-filter-label">商品类型</span>
              <Select
                options={[
                  { label: '全部类型', value: 'all' },
                  { label: '虚拟商品', value: 'virtual' },
                  { label: '闲鱼现货', value: 'physical' },
                ]}
                value={productTypeFilter}
                onChange={(value) => setProductTypeFilter(value as ProductTypeFilter)}
              />
            </div>
            <div className="product-filter-field">
              <span className="product-filter-label">时间范围</span>
              <Select
                options={[
                  { label: '近 7 天', value: 'last7Days' },
                  { label: '近 30 天', value: 'last30Days' },
                  { label: '近 90 天', value: 'last90Days' },
                  { label: '今天', value: 'today' },
                ]}
                value={filters.preset ?? 'last30Days'}
                onChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    preset: value,
                    startDate: undefined,
                    endDate: undefined,
                  }))
                }
              />
            </div>
          </div>

          <div className="product-toolbar">
            <Space wrap>
              <Button type="primary" icon={<SearchOutlined />} onClick={() => void reload()}>
                搜索
              </Button>
              <Button onClick={handleReset}>重置</Button>
              <Button icon={<ExportOutlined />} onClick={handleExport}>
                导出
              </Button>
              <Button
                icon={<CopyOutlined />}
                onClick={() => setBatchSearchOpen(true)}
              >
                批量搜索
              </Button>
              <Button
                icon={<SyncOutlined />}
                onClick={() => void handleSyncProducts()}
              >
                同步商品
              </Button>
              <Button
                icon={<PlusOutlined />}
                onClick={handleOpenPublishGuide}
              >
                发布指引
              </Button>
              <Button
                icon={<DeploymentUnitOutlined />}
                onClick={() => navigate('/workspace/move')}
              >
                一键搬家
              </Button>
            </Space>
          </div>
        </div>

        <div className="glass-panel product-table-shell">
          <div className="product-table-header">
            <div>
              <Typography.Title level={4} style={{ marginBottom: 8 }}>
                商品列表
              </Typography.Title>
              <Typography.Text type="secondary">
                表格字段尽量贴近目标站，包括商品编号、分类、价格、库存、店铺、上架时间和最后操作时间。
              </Typography.Text>
            </div>
            <Space wrap>
              <Tag color="blue">
                当前列表 {filteredRows.length}
                {overallProductCount > statusCounts.all ? ` / 筛选范围共 ${overallProductCount}` : ''}
              </Tag>
              {batchKeywords.length > 0 ? (
                <Tag
                  color="gold"
                  closable
                  onClose={(event) => {
                    event.preventDefault();
                    setBatchKeywords([]);
                    setBatchSearchText('');
                  }}
                >
                  批量搜索 {batchKeywords.length} 项
                </Tag>
              ) : null}
              <Button icon={<ReloadOutlined />} onClick={() => void reload()}>
                刷新列表
              </Button>
            </Space>
          </div>

          <Tabs activeKey={activeTab} items={tabItems} onChange={(key) => setActiveTab(key as ProductTabKey)} />

          {activeTab === 'actions' ? (
            <div className="product-ops-grid">
              {[
                {
                  key: 'sync',
                  title: '同步商品',
                  description: '按店铺重新拉取商品状态、库存和最近成交。',
                  action: '立即同步',
                  icon: <SyncOutlined />,
                },
                {
                  key: 'move',
                  title: '一键搬家',
                  description: '把当前商品复制到其他店铺或工作区继续运营。',
                  action: '进入搬家',
                  icon: <DeploymentUnitOutlined />,
                },
                {
                  key: 'new',
                  title: '发布指引',
                  description: '当前版本未接入商品发布 API，可先按指引完成人工发布与履约配置。',
                  action: '查看指引',
                  icon: <PlusOutlined />,
                },
                {
                  key: 'stores',
                  title: '店铺联动',
                  description: '跳转到店铺页查看授权、健康和接入状态。',
                  action: '查看店铺',
                  icon: <ShopOutlined />,
                },
              ].map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="product-op-card"
                  onClick={() =>
                    item.key === 'sync'
                      ? void handleSyncProducts()
                      : item.key === 'move'
                        ? navigate('/workspace/move')
                        : item.key === 'stores'
                          ? navigate('/stores')
                          : handleOpenPublishGuide()
                  }
                >
                  <div className="product-op-icon">{item.icon}</div>
                  <div className="product-op-title">{item.title}</div>
                  <div className="product-op-desc">{item.description}</div>
                  <div className="product-op-action">{item.action}</div>
                </button>
              ))}
            </div>
          ) : filteredRows.length > 0 ? (
            <Table
              rowKey="id"
              loading={loading}
              columns={productColumns}
              dataSource={filteredRows}
              pagination={{ pageSize: 8, showSizeChanger: false }}
              scroll={{ x: 1900 }}
            />
          ) : (
            <Empty
              description="当前状态在演示库中暂无对应商品，可切换到“销售中”或“所有商品”查看。"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              style={{ paddingBlock: 48 }}
            />
          )}
        </div>

        <div className="product-insight-grid">
          <div className="glass-panel product-insight-card">
            <Typography.Title level={4}>分类销售贡献</Typography.Title>
            <div className="product-insight-list">
              {(data?.products.categorySales ?? []).slice(0, 6).map((item) => (
                <div key={item.category} className="product-insight-row">
                  <div>
                    <div className="product-insight-name">{item.category}</div>
                    <div className="product-cell-meta">
                      销量 {formatNumber(item.soldQuantity, ' 件')}
                    </div>
                  </div>
                  <strong>{formatCurrency(item.salesAmount)}</strong>
                </div>
              ))}
            </div>
          </div>

          <div className="glass-panel product-insight-card">
            <Typography.Title level={4}>运营建议</Typography.Title>
            <div className="product-insight-list">
              <div className="product-insight-row">
                <div>
                  <div className="product-insight-name">低库存商品</div>
                  <div className="product-cell-meta">建议优先补货或切换供货来源</div>
                </div>
                <strong>{formatNumber(data?.products.summary.lowStockProducts ?? 0, ' 款')}</strong>
              </div>
              <div className="product-insight-row">
                <div>
                  <div className="product-insight-name">动销商品</div>
                  <div className="product-cell-meta">适合作为自动发布和调价重点</div>
                </div>
                <strong>{formatNumber(data?.products.summary.activeProducts ?? 0, ' 款')}</strong>
              </div>
              <div className="product-insight-row">
                <div>
                  <div className="product-insight-name">处理中商品</div>
                  <div className="product-cell-meta">存在售后或异常单的商品需要追踪</div>
                </div>
                <strong>{formatNumber(productRows.filter((row) => row.statusKey === 'processing').length, ' 款')}</strong>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Drawer
        title="商品履约与发货配置 (通道网关)"
        placement="right"
        onClose={() => setRuleOpen(null)}
        open={ruleOpen !== null}
        width={480}
        extra={
          <Space>
            <Button onClick={() => setRuleOpen(null)}>取消</Button>
            <Button type="primary" loading={ruleLoading} onClick={() => void handleSaveRule()}>
              保存配置
            </Button>
          </Space>
        }
      >
        <Alert
          message="自动化策略接管说明"
          description="在此页面为您店铺的该商品绑定后台的发货通道。当客户付款后，订单调度引擎会自动读取此处的配置进行派单并回传单号给闲鱼。"
          type="info"
          showIcon
          style={{ marginBottom: 24 }}
        />
        <Form form={ruleForm} layout="vertical" disabled={ruleLoading}>
          <Form.Item name="fulfillmentType" label="目标发货通道" rules={[{ required: true }]}>
            <Radio.Group>
              <Space direction="vertical">
                <Radio value="standard">
                  <Typography.Text strong>标准发货 (Manual / Card)</Typography.Text>
                  <div className="product-cell-meta">由自有库存卡密分发，或由店长手动填写单号。</div>
                </Radio>
                <Radio value="direct_charge">
                  <Typography.Text strong>虚拟商品API直充 (Direct Charge)</Typography.Text>
                  <div className="product-cell-meta">调用三方平台充值接口对接业务如话费、游戏点券。</div>
                </Radio>
                <Radio value="source_system">
                  <Typography.Text strong>自有货源系统下发 (Source API)</Typography.Text>
                  <div className="product-cell-meta">将订单推送至 1688 / Taobao 等外部仓库代发，自动同步单号。</div>
                </Radio>
              </Space>
            </Radio.Group>
          </Form.Item>
          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.fulfillmentType !== cur.fulfillmentType}
          >
            {({ getFieldValue }) => {
              const type = getFieldValue('fulfillmentType');
              if (type === 'standard') {
                return null;
              }
              const dropdownOptions =
                type === 'direct_charge'
                  ? adapters?.directChargeAdapters
                  : adapters?.sourceSystemAdapters;
              return (
                <div style={{ padding: 16, background: 'rgba(0,0,0,0.02)', borderRadius: 8, marginTop: -8 }}>
                  <Form.Item
                    name="supplierId"
                    label="选择执行代理供应商"
                    rules={[{ required: true, message: '请选择供应商通道' }]}
                  >
                    <Select
                      placeholder="请下拉选择上游通道"
                      options={dropdownOptions?.map((item) => ({
                        label: item.label,
                        value: item.key,
                      }))}
                    />
                  </Form.Item>
                  {type === 'source_system' && (
                    <Form.Item
                      name="externalSku"
                      label="绑定上游 SKU 编码"
                      extra="如外部平台(如1688)对应的商品映射编码，否则推送可能失败"
                      rules={[{ required: true, message: '请输入对应的外部 SKU' }]}
                    >
                      <Input placeholder="例如: SOURCE-SKU-1004" />
                    </Form.Item>
                  )}
                </div>
              );
            }}
          </Form.Item>
        </Form>
      </Drawer>

      <Drawer
        title={detailRow ? `${detailRow.name} 商品概览` : '商品概览'}
        placement="right"
        onClose={() => setDetailOpen(null)}
        open={detailOpen !== null}
        width={420}
      >
        {detailRow ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message="当前为只读概览"
              description="这里展示商品摘要和快捷动作。商品编辑与下架仍需后端发布接口接入后再开放。"
            />
            <div>
              <Typography.Title level={4} style={{ marginBottom: 8 }}>
                {detailRow.name}
              </Typography.Title>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                商品 ID {detailRow.id} / 商家编码 {detailRow.sku}
              </Typography.Paragraph>
            </div>
            <Space wrap>
              <Tag color={detailRow.statusColor}>{detailRow.statusLabel}</Tag>
              <Tag>{detailRow.productTypeLabel}</Tag>
              <Tag>{detailRow.category}</Tag>
            </Space>
            <div className="product-insight-list">
              <div className="product-insight-row">
                <div>
                  <div className="product-insight-name">所属店铺</div>
                  <div className="product-cell-meta">{detailRow.storeName}</div>
                </div>
                <strong>{detailRow.storeName}</strong>
              </div>
              <div className="product-insight-row">
                <div>
                  <div className="product-insight-name">售价 / 库存</div>
                  <div className="product-cell-meta">用于快速判断补货与调价优先级</div>
                </div>
                <strong>
                  {formatCurrency(detailRow.price)} / {formatNumber(detailRow.stock, ' 件')}
                </strong>
              </div>
              <div className="product-insight-row">
                <div>
                  <div className="product-insight-name">销量 / 销售额</div>
                  <div className="product-cell-meta">基于当前统计窗口的汇总结果</div>
                </div>
                <strong>
                  {formatNumber(detailRow.soldQuantity, ' 件')} / {formatCurrency(detailRow.salesAmount)}
                </strong>
              </div>
              <div className="product-insight-row">
                <div>
                  <div className="product-insight-name">最近成交</div>
                  <div className="product-cell-meta">最后一次销售时间</div>
                </div>
                <strong>{formatProductTime(detailRow.latestSaleAt)}</strong>
              </div>
            </div>
            <Space wrap>
              <Button onClick={() => void handleCopySummary(detailRow)}>复制摘要</Button>
              <Button onClick={() => handleFilterByStore(detailRow)}>同店筛选</Button>
              <Button type="primary" onClick={() => void handleOpenRule(detailRow.id)}>
                配置履约
              </Button>
            </Space>
          </Space>
        ) : (
          <Empty description="未找到对应商品" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        )}
      </Drawer>

      <Modal
        title="批量搜索商品"
        open={batchSearchOpen}
        onCancel={() => setBatchSearchOpen(false)}
        onOk={handleApplyBatchSearch}
        okText="应用筛选"
        cancelText="取消"
      >
        <Typography.Paragraph type="secondary">
          支持一行一个关键词，也支持用逗号分隔。系统会同时匹配商品标题和商家编码。
        </Typography.Paragraph>
        <Input.TextArea
          rows={8}
          value={batchSearchText}
          onChange={(event) => setBatchSearchText(event.target.value)}
          placeholder={'示例：\n王者点券\nSKU-10086\n会员月卡'}
        />
      </Modal>

      <Modal
        title="商品发布指引"
        open={publishGuideOpen}
        onCancel={() => setPublishGuideOpen(false)}
        footer={[
          <Button key="close" onClick={() => setPublishGuideOpen(false)}>
            关闭
          </Button>,
          <Button
            key="stores"
            type="primary"
            onClick={() => {
              setPublishGuideOpen(false);
              navigate('/stores');
            }}
          >
            去看店铺授权
          </Button>,
        ]}
      >
        <Space direction="vertical" size={12}>
          <Alert
            type="warning"
            showIcon
            message="当前版本未接入商品发布 API"
            description="为了避免误操作，页面不再伪造“新建商品”成功提示。需要发布商品时，请先确认店铺授权、商品素材和履约规则已经齐备。"
          />
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            1. 在店铺页确认闲鱼店铺授权和同步状态正常。
          </Typography.Paragraph>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            2. 在商品工作台完成商品筛选、批量搜索和履约配置。
          </Typography.Paragraph>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            3. 当前仍需在上游平台或后续发布模块中完成正式上架。
          </Typography.Paragraph>
        </Space>
      </Modal>
    </PageContainer>
  );
}
