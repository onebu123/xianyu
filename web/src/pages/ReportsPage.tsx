import { DownloadOutlined } from '@ant-design/icons';
import { PageContainer, ProCard } from '@ant-design/pro-components';
import { Alert, Button, Col, Row, Table, Tag, Typography, message } from 'antd';
import { useCallback, useMemo, useState } from 'react';

import {
  type BusinessReportsResponse,
  type FilterQuery,
  apiRequest,
  buildQuery,
} from '../api';
import { canExportReports } from '../access';
import { useAuth } from '../auth';
import { FilterBar } from '../components/FilterBar';
import { SummaryCards } from '../components/SummaryCards';
import { useRemoteData } from '../hooks/useRemoteData';
import { formatCurrency, formatNumber } from '../utils';

function formatMetric(value: number, unit: string) {
  if (unit === 'CNY') {
    return formatCurrency(value);
  }
  if (unit === '%') {
    return `${value.toFixed(2)}%`;
  }
  return formatNumber(value, unit ? ` ${unit}` : '');
}

export function ReportsPage() {
  const { user } = useAuth();
  const [filters, setFilters] = useState<FilterQuery>({ preset: 'last30Days' });
  const queryString = useMemo(() => buildQuery(filters), [filters]);

  const loader = useCallback(
    async () =>
      apiRequest<BusinessReportsResponse>(`/api/reports?${queryString}`, undefined),
    [queryString],
  );

  const { data, loading, error } = useRemoteData<BusinessReportsResponse>(loader);

  const paymentCards = useMemo(
    () =>
      data
        ? [
            {
              key: 'grossAmount',
              label: '订单原额',
              value: data.paymentSummary.grossAmount,
              unit: 'CNY',
            },
            {
              key: 'discountAmount',
              label: '优惠金额',
              value: data.paymentSummary.discountAmount,
              unit: 'CNY',
            },
            {
              key: 'receivedAmount',
              label: '实收金额',
              value: data.paymentSummary.receivedAmount,
              unit: 'CNY',
            },
            {
              key: 'refundAmount',
              label: '退款金额',
              value: data.paymentSummary.refundAmount,
              unit: 'CNY',
            },
            {
              key: 'paymentCount',
              label: '支付笔数',
              value: data.paymentSummary.paymentCount,
              unit: '笔',
            },
          ]
        : [],
    [data],
  );

  const orderOverviewCards = useMemo(
    () =>
      (data?.orderStats.overview ?? []).map((item) => ({
        key: item.key,
        label: item.label,
        value: item.value,
        unit: item.unit,
      })),
    [data],
  );

  const afterSaleOverviewCards = useMemo(
    () =>
      (data?.afterSaleStats.overview ?? []).map((item) => ({
        key: item.key,
        label: item.label,
        value: item.value,
        unit: item.unit,
      })),
    [data],
  );

  return (
    <PageContainer
      title="报表中心"
      subTitle="统一输出真实订单、支付、履约和售后口径，支持多店铺筛选与经营复盘导出"
      style={{ paddingInline: 0 }}
      extra={[
        <Button
          key="report-export"
          type="primary"
          icon={<DownloadOutlined />}
          disabled={!canExportReports(user?.role)}
          onClick={async () => {
            try {
              const csv = await apiRequest<string>(
                `/api/reports/export?${queryString}`,
                undefined,
              );
              const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
              const url = window.URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = `business-report-${data?.range.startDate ?? 'range'}-${data?.range.endDate ?? 'range'}.csv`;
              link.click();
              window.URL.revokeObjectURL(url);
            } catch (err) {
              message.error(err instanceof Error ? err.message : '导出失败');
            }
          }}
        >
          导出经营报表
        </Button>,
      ]}
    >
      <div className="page-grid">
        <FilterBar
          filters={filters}
          onChange={setFilters}
          stores={data?.filters.stores ?? []}
          products={data?.filters.products ?? []}
          categories={data?.filters.categories ?? []}
          sources={data?.filters.sources ?? []}
          showKeyword
          storeMode="multiple"
        />

        {error ? <Alert type="error" showIcon message={error} /> : null}
        {data ? <SummaryCards items={data.summary} /> : null}

        <Row gutter={[16, 16]}>
          <Col xs={24} xl={14}>
            <ProCard
              title="利润口径"
              className="glass-panel"
              bordered={false}
              extra={<Tag color="processing">页面 / 接口 / 导出一致</Tag>}
            >
              <Table
                rowKey="key"
                loading={loading}
                pagination={false}
                columns={[
                  { title: '指标', dataIndex: 'label', width: 120 },
                  {
                    title: '数值',
                    dataIndex: 'value',
                    width: 120,
                    render: (value: number, row: BusinessReportsResponse['formulas'][number]) =>
                      formatMetric(value, row.unit),
                  },
                  { title: '公式', dataIndex: 'formula', width: 260 },
                  { title: '说明', dataIndex: 'description' },
                ]}
                dataSource={data?.formulas ?? []}
              />
            </ProCard>
          </Col>
          <Col xs={24} xl={10}>
            <ProCard
              title="支付资金口径"
              className="glass-panel"
              bordered={false}
              extra={
                data ? (
                  <Typography.Text type="secondary">
                    {data.range.startDate} 至 {data.range.endDate}
                  </Typography.Text>
                ) : null
              }
            >
              <SummaryCards items={paymentCards} />
            </ProCard>
          </Col>
        </Row>

        <ProCard title="店铺维度统计" className="glass-panel" bordered={false}>
          <Table
            rowKey="storeId"
            loading={loading}
            pagination={{ pageSize: 8 }}
            columns={[
              { title: '店铺', dataIndex: 'storeName', width: 180, fixed: 'left' },
              {
                title: '订单数',
                dataIndex: 'orderCount',
                width: 100,
                render: (value: number) => formatNumber(value, ' 单'),
              },
              {
                title: '实收金额',
                dataIndex: 'salesAmount',
                width: 120,
                render: (value: number) => formatCurrency(value),
              },
              {
                title: '退款金额',
                dataIndex: 'refundAmount',
                width: 120,
                render: (value: number) => formatCurrency(value),
              },
              {
                title: '净销售额',
                dataIndex: 'netSalesAmount',
                width: 120,
                render: (value: number) => formatCurrency(value),
              },
              {
                title: '毛利',
                dataIndex: 'grossProfit',
                width: 120,
                render: (value: number) => formatCurrency(value),
              },
              {
                title: '毛利率',
                dataIndex: 'grossMargin',
                width: 100,
                render: (value: number) => `${value.toFixed(2)}%`,
              },
              {
                title: '售后单数',
                dataIndex: 'afterSaleCases',
                width: 100,
                render: (value: number) => formatNumber(value, ' 单'),
              },
              {
                title: '履约成功率',
                dataIndex: 'successFulfillmentRate',
                width: 120,
                render: (value: number) => `${value.toFixed(2)}%`,
              },
              {
                title: '人工处理单',
                dataIndex: 'manualReviewCount',
                width: 110,
                render: (value: number) => formatNumber(value, ' 单'),
              },
              {
                title: '平均发货时长',
                dataIndex: 'averageDeliveryHours',
                width: 120,
                render: (value: number) => formatNumber(value, ' 小时'),
              },
            ]}
            dataSource={data?.storeStats ?? []}
            scroll={{ x: 1280 }}
          />
        </ProCard>

        <ProCard title="商品维度统计" className="glass-panel" bordered={false}>
          <Table
            rowKey="productId"
            loading={loading}
            pagination={{ pageSize: 8 }}
            columns={[
              { title: '商品', dataIndex: 'productName', width: 220, fixed: 'left' },
              { title: 'SKU', dataIndex: 'productSku', width: 120 },
              { title: '店铺', dataIndex: 'storeName', width: 160 },
              { title: '分类', dataIndex: 'category', width: 140 },
              {
                title: '订单数',
                dataIndex: 'orderCount',
                width: 100,
                render: (value: number) => formatNumber(value, ' 单'),
              },
              {
                title: '销量',
                dataIndex: 'soldQuantity',
                width: 100,
                render: (value: number) => formatNumber(value, ' 件'),
              },
              {
                title: '实收金额',
                dataIndex: 'salesAmount',
                width: 120,
                render: (value: number) => formatCurrency(value),
              },
              {
                title: '退款金额',
                dataIndex: 'refundAmount',
                width: 120,
                render: (value: number) => formatCurrency(value),
              },
              {
                title: '净销售额',
                dataIndex: 'netSalesAmount',
                width: 120,
                render: (value: number) => formatCurrency(value),
              },
              {
                title: '毛利',
                dataIndex: 'grossProfit',
                width: 120,
                render: (value: number) => formatCurrency(value),
              },
              {
                title: '毛利率',
                dataIndex: 'grossMargin',
                width: 100,
                render: (value: number) => `${value.toFixed(2)}%`,
              },
              {
                title: '售后单数',
                dataIndex: 'afterSaleCases',
                width: 100,
                render: (value: number) => formatNumber(value, ' 单'),
              },
              {
                title: '履约成功率',
                dataIndex: 'successFulfillmentRate',
                width: 120,
                render: (value: number) => `${value.toFixed(2)}%`,
              },
            ]}
            dataSource={data?.productStats ?? []}
            scroll={{ x: 1480 }}
          />
        </ProCard>

        <ProCard title="订单维度统计" className="glass-panel" bordered={false}>
          <SummaryCards items={orderOverviewCards} />
          <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
            <Col xs={24} xl={8}>
              <Table
                rowKey="status"
                loading={loading}
                pagination={false}
                title={() => '订单主状态分布'}
                columns={[
                  { title: '状态', dataIndex: 'label' },
                  {
                    title: '订单数',
                    dataIndex: 'orderCount',
                    render: (value: number) => formatNumber(value, ' 单'),
                  },
                ]}
                dataSource={data?.orderStats.statusDistribution ?? []}
              />
            </Col>
            <Col xs={24} xl={8}>
              <Table
                rowKey="source"
                loading={loading}
                pagination={false}
                title={() => '订单来源分布'}
                columns={[
                  { title: '来源', dataIndex: 'source' },
                  {
                    title: '订单数',
                    dataIndex: 'orderCount',
                    render: (value: number) => formatNumber(value, ' 单'),
                  },
                  {
                    title: '实收金额',
                    dataIndex: 'salesAmount',
                    render: (value: number) => formatCurrency(value),
                  },
                ]}
                dataSource={data?.orderStats.sourceDistribution ?? []}
              />
            </Col>
            <Col xs={24} xl={8}>
              <Table
                rowKey="queue"
                loading={loading}
                pagination={false}
                title={() => '履约队列分布'}
                columns={[
                  { title: '履约队列', dataIndex: 'label' },
                  {
                    title: '订单数',
                    dataIndex: 'orderCount',
                    render: (value: number) => formatNumber(value, ' 单'),
                  },
                ]}
                dataSource={data?.orderStats.fulfillmentDistribution ?? []}
              />
            </Col>
          </Row>
        </ProCard>

        <ProCard title="售后维度统计" className="glass-panel" bordered={false}>
          <SummaryCards items={afterSaleOverviewCards} />
          <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
            <Col xs={24} xl={14}>
              <Table
                rowKey="caseType"
                loading={loading}
                pagination={false}
                title={() => '售后类型分布'}
                columns={[
                  { title: '类型', dataIndex: 'caseTypeText' },
                  {
                    title: '单量',
                    dataIndex: 'caseCount',
                    render: (value: number) => formatNumber(value, ' 单'),
                  },
                  {
                    title: '已完结',
                    dataIndex: 'resolvedCount',
                    render: (value: number) => formatNumber(value, ' 单'),
                  },
                  {
                    title: '超时',
                    dataIndex: 'timeoutCount',
                    render: (value: number) => formatNumber(value, ' 单'),
                  },
                  {
                    title: '退款金额',
                    dataIndex: 'refundAmount',
                    render: (value: number) => formatCurrency(value),
                  },
                  {
                    title: '补偿金额',
                    dataIndex: 'compensationAmount',
                    render: (value: number) => formatCurrency(value),
                  },
                ]}
                dataSource={data?.afterSaleStats.typeDistribution ?? []}
              />
            </Col>
            <Col xs={24} xl={10}>
              <Table
                rowKey="caseStatus"
                loading={loading}
                pagination={false}
                title={() => '售后状态分布'}
                columns={[
                  { title: '状态', dataIndex: 'caseStatusText' },
                  {
                    title: '单量',
                    dataIndex: 'caseCount',
                    render: (value: number) => formatNumber(value, ' 单'),
                  },
                ]}
                dataSource={data?.afterSaleStats.statusDistribution ?? []}
              />
            </Col>
          </Row>
        </ProCard>

        <ProCard title="时间趋势" className="glass-panel" bordered={false}>
          <Table
            rowKey="reportDate"
            loading={loading}
            pagination={{ pageSize: 10 }}
            columns={[
              { title: '日期', dataIndex: 'reportDate', width: 120 },
              {
                title: '订单原额',
                dataIndex: 'grossAmount',
                width: 120,
                render: (value: number) => formatCurrency(value),
              },
              {
                title: '实收金额',
                dataIndex: 'receivedAmount',
                width: 120,
                render: (value: number) => formatCurrency(value),
              },
              {
                title: '退款金额',
                dataIndex: 'refundAmount',
                width: 120,
                render: (value: number) => formatCurrency(value),
              },
              {
                title: '净利润',
                dataIndex: 'netProfit',
                width: 120,
                render: (value: number) => formatCurrency(value),
              },
              {
                title: '订单数',
                dataIndex: 'orderCount',
                width: 100,
                render: (value: number) => formatNumber(value, ' 单'),
              },
              {
                title: '售后单数',
                dataIndex: 'afterSaleCaseCount',
                width: 100,
                render: (value: number) => formatNumber(value, ' 单'),
              },
            ]}
            dataSource={data?.trend ?? []}
          />
        </ProCard>
      </div>
    </PageContainer>
  );
}
