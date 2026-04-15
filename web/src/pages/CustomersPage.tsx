import { Alert, Col, Row, Table } from 'antd';
import { PageContainer, ProCard } from '@ant-design/pro-components';
import { useCallback, useMemo, useState } from 'react';

import {
  type CustomersResponse,
  type DashboardResponse,
  type FilterQuery,
  apiRequest,
  buildQuery,
} from '../api';
import { BarChart } from '../components/Charts';
import { FilterBar } from '../components/FilterBar';
import { SummaryCards } from '../components/SummaryCards';
import { useRemoteData } from '../hooks/useRemoteData';
import { formatCurrency, formatNumber } from '../utils';

interface CustomersPageData {
  options: DashboardResponse['filters'];
  customers: CustomersResponse;
}

export function CustomersPage() {
  const [filters, setFilters] = useState<FilterQuery>({ preset: 'last30Days' });
  const queryString = useMemo(() => buildQuery(filters), [filters]);

  const loader = useCallback(async () => {
    const [options, customers] = await Promise.all([
      apiRequest<DashboardResponse['filters']>('/api/options', undefined),
      apiRequest<CustomersResponse>(`/api/customers?${queryString}`, undefined),
    ]);
    return { options, customers };
  }, [queryString]);
  const { data, loading, error } = useRemoteData<CustomersPageData>(loader);

  const summary = data
    ? [
        {
          key: 'customerCount',
          label: '成交客户数',
          value: data.customers.summary.customerCount,
          unit: '单',
        },
        {
          key: 'newCustomers',
          label: '新客数',
          value: data.customers.summary.newCustomers,
          unit: '单',
        },
        {
          key: 'repeatCustomers',
          label: '复购客户数',
          value: data.customers.summary.repeatCustomers,
          unit: '单',
        },
        { key: 'repeatRate', label: '复购率', value: data.customers.summary.repeatRate, unit: '%' },
      ]
    : [];

  return (
    <PageContainer
      title="客户分析"
      subTitle="跟踪新客、复购与地区分布"
      style={{ paddingInline: 0 }}
    >
      <div className="page-grid">
        <FilterBar
          filters={filters}
          onChange={setFilters}
          stores={data?.options.stores ?? []}
          categories={data?.options.categories ?? []}
          sources={data?.options.sources ?? []}
        />

        {error ? <Alert type="error" showIcon message={error} /> : null}
        {data ? <SummaryCards items={summary} /> : null}

        <Row gutter={[16, 16]}>
          <Col xs={24} xl={8}>
            <ProCard title="地区成交分布" className="glass-panel" bordered={false}>
              <BarChart
                rows={(data?.customers.provinceRows ?? []).map((item) => ({
                  name: item.province,
                  value: item.salesAmount,
                }))}
              />
            </ProCard>
          </Col>
          <Col xs={24} xl={16}>
            <ProCard title="高价值客户" className="glass-panel" bordered={false}>
              <Table
                rowKey="id"
                loading={loading}
                pagination={false}
                columns={[
                  { title: '客户', dataIndex: 'name' },
                  { title: '地区', dataIndex: 'province' },
                  {
                    title: '订单数',
                    dataIndex: 'orderCount',
                    render: (value: number) => formatNumber(value, ' 单'),
                  },
                  {
                    title: '累计消费',
                    dataIndex: 'totalSpend',
                    render: (value: number) => formatCurrency(value),
                  },
                  { title: '最近下单', dataIndex: 'latestOrderAt' },
                ]}
                dataSource={data?.customers.customerList ?? []}
              />
            </ProCard>
          </Col>
        </Row>
      </div>
    </PageContainer>
  );
}
