import { Button, Card, DatePicker, Input, Select, Segmented, Space } from 'antd';
import dayjs from 'dayjs';

import type { FilterQuery } from '../api';

const { RangePicker } = DatePicker;

interface FilterBarProps {
  filters: FilterQuery;
  onChange: (next: FilterQuery) => void;
  stores: Array<{ label: string; value: number }>;
  products?: Array<{ label: string; value: number }>;
  categories?: Array<{ label: string; value: string }>;
  sources?: Array<{ label: string; value: string }>;
  showKeyword?: boolean;
  storeMode?: 'single' | 'multiple';
}

export function FilterBar({
  filters,
  onChange,
  stores,
  products = [],
  categories = [],
  sources = [],
  showKeyword = false,
  storeMode = 'single',
}: FilterBarProps) {
  return (
    <Card className="glass-panel" styles={{ body: { padding: 16 } }}>
      <Space wrap size={[12, 12]}>
        <Segmented
          options={[
            { label: '今天', value: 'today' },
            { label: '近7天', value: 'last7Days' },
            { label: '近30天', value: 'last30Days' },
            { label: '近90天', value: 'last90Days' },
          ]}
          value={filters.preset ?? 'last30Days'}
          onChange={(value) =>
            onChange({
              ...filters,
              preset: String(value),
              startDate: undefined,
              endDate: undefined,
            })
          }
        />
        <RangePicker
          allowClear
          value={
            filters.startDate && filters.endDate
              ? [dayjs(filters.startDate), dayjs(filters.endDate)]
              : undefined
          }
          onChange={(value) =>
            onChange({
              ...filters,
              preset: undefined,
              startDate: value?.[0]?.format('YYYY-MM-DD'),
              endDate: value?.[1]?.format('YYYY-MM-DD'),
            })
          }
        />
        <Select
          allowClear
          placeholder="店铺"
          style={{ width: 160 }}
          mode={storeMode === 'multiple' ? 'multiple' : undefined}
          maxTagCount={storeMode === 'multiple' ? 2 : undefined}
          options={stores}
          value={storeMode === 'multiple' ? filters.storeIds : filters.storeId}
          onChange={(value) =>
            onChange(
              storeMode === 'multiple'
                ? {
                    ...filters,
                    storeId: undefined,
                    storeIds:
                      value === undefined
                        ? undefined
                        : Array.isArray(value)
                          ? value.map((item) => Number(item))
                          : [Number(value)],
                  }
                : {
                    ...filters,
                    storeIds: undefined,
                    storeId:
                      value === undefined
                        ? undefined
                        : Array.isArray(value)
                          ? Number(value[0])
                          : Number(value),
                  },
            )
          }
        />
        {products.length > 0 ? (
          <Select
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="商品"
            style={{ width: 200 }}
            options={products}
            value={filters.productId}
            onChange={(value) => onChange({ ...filters, productId: value })}
          />
        ) : null}
        {categories.length > 0 ? (
          <Select
            allowClear
            placeholder="分类"
            style={{ width: 160 }}
            options={categories}
            value={filters.category}
            onChange={(value) => onChange({ ...filters, category: value })}
          />
        ) : null}
        {sources.length > 0 ? (
          <Select
            allowClear
            placeholder="来源"
            style={{ width: 160 }}
            options={sources}
            value={filters.source}
            onChange={(value) => onChange({ ...filters, source: value })}
          />
        ) : null}
        {showKeyword ? (
          <Input.Search
            allowClear
            placeholder="搜索订单号 / 商品 / 客户"
            style={{ width: 260 }}
            value={filters.keyword}
            onChange={(event) => onChange({ ...filters, keyword: event.target.value })}
          />
        ) : null}
        <Button onClick={() => onChange({ preset: 'last30Days' })}>重置筛选</Button>
      </Space>
    </Card>
  );
}
