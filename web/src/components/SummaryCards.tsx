import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { Col, Row } from 'antd';

import { formatCurrency, formatNumber } from '../utils';

interface SummaryItem {
  key: string;
  label: string;
  value: number;
  unit: string;
  compareRate?: number;
}

function formatValue(item: SummaryItem) {
  if (item.unit === 'CNY') {
    return formatCurrency(item.value);
  }
  if (item.unit === '%') {
    return `${item.value.toFixed(2)}%`;
  }
  return formatNumber(item.value, item.unit ? ` ${item.unit}` : '');
}

export function SummaryCards({ items }: { items: SummaryItem[] }) {
  return (
    <Row gutter={[16, 16]} className="summary-card-grid">
      {items.map((item) => (
        <Col xs={24} sm={12} xl={6} key={item.key}>
          <div className="summary-card glass-panel">
            <div className="summary-card-top">
              <div className="summary-card-label">{item.label}</div>
              <div className="summary-card-unit">
                {item.unit === 'CNY' ? '金额' : item.unit || '指标'}
              </div>
            </div>
            <div className="summary-card-value">{formatValue(item)}</div>
            {item.compareRate !== undefined ? (
              <div
                className={`summary-card-trend${item.compareRate >= 0 ? ' is-positive' : ' is-negative'}`}
              >
                {item.compareRate >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />} 较上期{' '}
                {Math.abs(item.compareRate).toFixed(2)}%
              </div>
            ) : null}
            <div className="summary-card-foot">当前筛选口径下自动聚合</div>
          </div>
        </Col>
      ))}
    </Row>
  );
}
