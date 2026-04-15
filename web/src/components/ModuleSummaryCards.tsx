import { Col, Row } from 'antd';
import type { WorkspaceOverviewResponse } from '../api';

/**
 * 模块概览卡片 — 渲染 overview.summary 数组
 * 用于 FishCoin/Move/School/LimitedPurchase 等 overview-only 页面
 */
export function ModuleSummaryCards({ summary }: { summary: WorkspaceOverviewResponse['summary'] }) {
  if (!summary?.length) return null;
  return (
    <Row gutter={[16, 16]}>
      {summary.map((s) => (
        <Col xs={24} sm={8} key={s.label}>
          <div className="module-summary-card">
            <div className="module-summary-label">{s.label}</div>
            <div className="module-summary-value">
              {s.value}
              <span className="module-summary-unit">{s.unit}</span>
            </div>
            <div className="module-summary-meta">{s.meta}</div>
          </div>
        </Col>
      ))}
    </Row>
  );
}
