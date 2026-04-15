import ReactECharts from 'echarts-for-react';

interface TrendChartProps {
  rows: Array<{
    reportDate: string;
    salesAmount: number;
    orderCount: number;
    refundAmount: number;
  }>;
}

interface PieChartProps {
  rows: Array<{ name: string; value: number }>;
  colors?: string[];
}

interface BarChartProps {
  rows: Array<{ name: string; value: number }>;
}

export function TrendChart({ rows }: TrendChartProps) {
  return (
    <ReactECharts
      style={{ height: 320 }}
      option={{
        color: ['#ff6a3d', '#2e938c', '#f2b15a'],
        tooltip: { trigger: 'axis' },
        legend: { top: 0 },
        grid: { left: 12, right: 12, top: 48, bottom: 12, containLabel: true },
        xAxis: {
          type: 'category',
          data: rows.map((row) => row.reportDate),
          boundaryGap: false,
        },
        yAxis: [
          { type: 'value', name: '金额' },
          { type: 'value', name: '订单数' },
        ],
        series: [
          {
            name: '支付GMV',
            type: 'line',
            smooth: true,
            areaStyle: {
              color: 'rgba(255, 106, 61, 0.12)',
            },
            data: rows.map((row) => row.salesAmount),
          },
          {
            name: '支付订单数',
            type: 'line',
            smooth: true,
            yAxisIndex: 1,
            data: rows.map((row) => row.orderCount),
          },
          {
            name: '退款金额',
            type: 'bar',
            barMaxWidth: 16,
            data: rows.map((row) => row.refundAmount),
          },
        ],
      }}
    />
  );
}

export function PieChart({ rows, colors }: PieChartProps) {
  return (
    <ReactECharts
      style={{ height: 300 }}
      option={{
        color: colors ?? ['#ff6a3d', '#2e938c', '#f2b15a', '#7d8cf7', '#8b6d5c'],
        tooltip: { trigger: 'item' },
        legend: { bottom: 0 },
        series: [
          {
            type: 'pie',
            radius: ['48%', '74%'],
            itemStyle: {
              borderRadius: 12,
              borderColor: '#fff',
              borderWidth: 4,
            },
            label: {
              formatter: '{b}\n{d}%',
            },
            data: rows,
          },
        ],
      }}
    />
  );
}

export function BarChart({ rows }: BarChartProps) {
  return (
    <ReactECharts
      style={{ height: 300 }}
      option={{
        color: ['#2e938c'],
        tooltip: { trigger: 'axis' },
        grid: { left: 12, right: 12, top: 16, bottom: 24, containLabel: true },
        xAxis: {
          type: 'value',
        },
        yAxis: {
          type: 'category',
          data: rows.map((row) => row.name),
        },
        series: [
          {
            type: 'bar',
            data: rows.map((row) => row.value),
            barWidth: 18,
            itemStyle: {
              borderRadius: [0, 10, 10, 0],
            },
          },
        ],
      }}
    />
  );
}
