import {
  FileTextOutlined,
  ReloadOutlined,
  SafetyOutlined,
  ShopOutlined,
  ShoppingCartOutlined,
  ShoppingOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { Alert, Button, Select, Segmented, Skeleton, Space, Tag, Typography } from 'antd';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';

import type { DashboardResponse, FilterQuery, OrdersOverview, ProductsResponse } from '../api';
import { apiRequest, buildQuery } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { formatCurrency, formatNumber } from '../utils';

interface DashboardPageData {
  options: DashboardResponse['filters'];
  today: DashboardResponse;
  period: DashboardResponse;
  products: ProductsResponse;
  orders: OrdersOverview;
}

interface ModuleCard {
  label: string;
  value: number;
  unit: string;
  meta?: string;
  accent?: string;
}

function formatMetric(value: number, unit: string) {
  if (unit === 'CNY') {
    return formatCurrency(value);
  }
  if (unit === '%') {
    return `${Number(value ?? 0).toFixed(2)}%`;
  }
  return formatNumber(value, unit ? ` ${unit}` : '');
}

function DashboardSection({
  title,
  description,
  extra,
  children,
}: {
  title: string;
  description: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="functional-section">
      <div className="functional-section-header">
        <div>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            {title}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {description}
          </Typography.Text>
        </div>
        {extra}
      </div>
      {children}
    </section>
  );
}

function ModuleGrid({ items }: { items: ModuleCard[] }) {
  return (
    <div className="functional-card-grid">
      {items.map((item) => (
        <div key={item.label} className="functional-card">
          <div className="functional-card-label">{item.label}</div>
          <div className="functional-card-value">{formatMetric(item.value, item.unit)}</div>
          <div className="functional-card-meta">{item.meta ?? ''}</div>
        </div>
      ))}
    </div>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const [storeId, setStoreId] = useState<number | undefined>();
  const [orderPreset, setOrderPreset] = useState<FilterQuery['preset']>('today');

  const todayQuery = useMemo(() => buildQuery({ preset: 'today', storeId }), [storeId]);
  const periodQuery = useMemo(
    () => buildQuery({ preset: orderPreset, storeId }),
    [orderPreset, storeId],
  );
  const productQuery = useMemo(() => buildQuery({ preset: 'last30Days', storeId }), [storeId]);

  const loader = useCallback(async () => {
    const [options, today, period, products, orders] = await Promise.all([
      apiRequest<DashboardResponse['filters']>('/api/options', undefined),
      apiRequest<DashboardResponse>(`/api/dashboard?${todayQuery}`, undefined),
      apiRequest<DashboardResponse>(`/api/dashboard?${periodQuery}`, undefined),
      apiRequest<ProductsResponse>(`/api/products?${productQuery}`, undefined),
      apiRequest<OrdersOverview>(`/api/orders/overview?${periodQuery}`, undefined),
    ]);

    return { options, today, period, products, orders };
  }, [periodQuery, productQuery, todayQuery]);

  const { data, loading, error, reload } = useRemoteData<DashboardPageData>(loader);

  /* ── 待处理 ── */
  const operationCards = useMemo(() => {
    if (!data) return [];
    const afterSaleMap = new Map(
      data.period.modules.businessCards.afterSaleStats.map((item) => [item.label, item]),
    );
    return [
      { label: '待发货订单', value: data.orders.pendingShipment, unit: '单', meta: '需优先跟进' },
      { label: '进行中售后', value: afterSaleMap.get('进行中售后')?.value ?? 0, unit: '单', meta: '尽快处理' },
      { label: '低库存商品', value: data.products.summary.lowStockProducts, unit: '款', meta: '库存 < 30 件' },
      { label: '退款金额', value: afterSaleMap.get('退款金额')?.value ?? 0, unit: 'CNY', meta: '当前周期累计' },
    ] satisfies ModuleCard[];
  }, [data]);

  /* ── 今日 ── */
  const todaySummaryCards = useMemo(() => {
    if (!data) return [];
    return data.today.modules.todayCards.map((item) => ({
      label: item.label,
      value: item.value,
      unit: item.unit,
    }));
  }, [data]);

  /* ── 商品 ── */
  const productCards = useMemo(() => {
    if (!data) return [];
    const s = data.products.summary;
    return [
      { label: '在售商品', value: s.totalProducts, unit: '款' },
      { label: '动销商品', value: s.activeProducts, unit: '款' },
      { label: '低库存', value: s.lowStockProducts, unit: '款' },
      { label: '分类数', value: s.categoryCount, unit: '类' },
      { label: '在售库存', value: s.totalStock, unit: '件' },
      { label: '销售件数', value: s.soldQuantity, unit: '件' },
      { label: '销售额', value: s.salesAmount, unit: 'CNY' },
    ] satisfies ModuleCard[];
  }, [data]);

  /* ── 订单 ── */
  const orderCards = useMemo(() => {
    if (!data) return [];
    const o = data.orders;
    return [
      { label: '所有订单', value: o.totalOrders, unit: '单', meta: `GMV ${formatCurrency(o.salesAmount)}` },
      { label: '等待发货', value: o.pendingShipment, unit: '单' },
      { label: '已经发货', value: o.shippedOrders, unit: '单' },
      { label: '交易成功', value: o.completedOrders, unit: '单' },
      { label: '售后订单', value: o.afterSaleOrders, unit: '单' },
      { label: '平均发货', value: o.averageDeliveryHours, unit: '小时' },
    ] satisfies ModuleCard[];
  }, [data]);

  /* ── 售后 ── */
  const afterSaleCards = useMemo(() => {
    if (!data) return [];
    return data.period.modules.businessCards.afterSaleStats.map((item) => ({
      label: item.label,
      value: item.value,
      unit: item.unit,
    }));
  }, [data]);

  /* ── 常用功能 ── */
  const commonActions = useMemo(
    () => [
      { key: 'publish', title: '商品发布', desc: '查看在售商品与上架节奏', icon: <ShoppingOutlined />, path: '/products' },
      { key: 'move', title: '一键搬家', desc: '跨店铺商品迁移任务', icon: <ShopOutlined />, path: '/workspace/move' },
      { key: 'shipment', title: '批量发货', desc: '快速筛出待发货批次', icon: <ShoppingCartOutlined />, path: '/orders' },
      { key: 'service', title: 'AI 客服', desc: '会话管理与接管记录', icon: <SafetyOutlined />, path: '/workspace/ai-service' },
      { key: 'customers', title: '客户管理', desc: '客户画像与复购分析', icon: <TeamOutlined />, path: '/customers' },
      { key: 'reports', title: '经营报表', desc: '成交、利润与来源结构', icon: <FileTextOutlined />, path: '/reports' },
    ],
    [],
  );

  const periodLabel =
    orderPreset === 'today'
      ? '当天'
      : orderPreset === 'last7Days'
        ? '近 7 天'
        : orderPreset === 'last30Days'
          ? '近 30 天'
          : '近 90 天';

  return (
    <div className="functional-dashboard" data-testid="functional-dashboard">
      {/* ── 欢迎区 ── */}
      <div className="functional-dashboard-hero">
        <div>
          <Tag color="geekblue" style={{ marginBottom: 4 }}>经营总控台</Tag>
          <Typography.Title level={2} style={{ marginTop: 8, marginBottom: 6 }}>
            业务总览
          </Typography.Title>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            整合待处理、今日/周期统计、商品与订单核心指标。
          </Typography.Paragraph>
        </div>
        <Space wrap size={12}>
          <Select
            allowClear
            placeholder="所有店铺"
            style={{ width: 180 }}
            options={data?.options.stores ?? []}
            value={storeId}
            onChange={(value) => setStoreId(value)}
          />
          <Segmented
            value={orderPreset}
            onChange={(value) => setOrderPreset(value as FilterQuery['preset'])}
            options={[
              { label: '当天', value: 'today' },
              { label: '7天', value: 'last7Days' },
              { label: '30天', value: 'last30Days' },
              { label: '90天', value: 'last90Days' },
            ]}
          />
          <Button
            icon={<ReloadOutlined />}
            size="small"
            onClick={() => void reload()}
            style={{ borderRadius: 8 }}
          >
            刷新
          </Button>
        </Space>
      </div>

      <div className="functional-dashboard-meta">
        <span>周期：{periodLabel}</span>
        <span>更新：{dayjs().format('HH:mm:ss')}</span>
      </div>

      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}

      {loading || !data ? (
        <Skeleton active paragraph={{ rows: 16 }} />
      ) : (
        <div className="functional-dashboard-body">
          <DashboardSection title="待处理" description="需要马上跟进的订单、售后与库存预警">
            <ModuleGrid items={operationCards} />
          </DashboardSection>

          <DashboardSection
            title="今日统计"
            description="当天口径核心成交指标"
            extra={<Tag color="processing">今日</Tag>}
          >
            <ModuleGrid items={todaySummaryCards} />
          </DashboardSection>

          <DashboardSection
            title="商品统计"
            description="在售、动销、库存和销售额"
            extra={<Tag color="green">近 30 天</Tag>}
          >
            <ModuleGrid items={productCards} />
          </DashboardSection>

          <DashboardSection
            title="订单统计"
            description="订单状态看板和发货效率"
            extra={<Tag color="blue">{periodLabel}</Tag>}
          >
            <ModuleGrid items={orderCards} />
          </DashboardSection>

          <DashboardSection title="售后统计" description="售后数量、退款金额和完结率">
            <ModuleGrid items={afterSaleCards} />
          </DashboardSection>

          <DashboardSection title="常用功能" description="核心模块快速入口">
            <div className="functional-action-grid">
              {commonActions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  className="functional-action-card"
                  onClick={() => navigate(action.path)}
                >
                  <div className="functional-action-icon">{action.icon}</div>
                  <div>
                    <div className="functional-action-title">{action.title}</div>
                    <div className="functional-action-desc">{action.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </DashboardSection>

          <div className="functional-dashboard-footer">
            <Button type="primary" onClick={() => navigate('/stores')}>
              店铺管理
            </Button>
            <Button onClick={() => navigate('/orders')}>订单明细</Button>
            <Button onClick={() => navigate('/after-sale')}>售后列表</Button>
          </div>
        </div>
      )}
    </div>
  );
}
