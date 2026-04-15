import { Tag } from 'antd';
import type { TableProps } from 'antd';
import type { WorkspaceOverviewResponse } from '../api';

/**
 * 通用的操作日志表格列定义
 * 用于 FishCoin/Move/School 等多个页面，避免重复定义
 */
export const logColumns: TableProps<WorkspaceOverviewResponse['logs'][number]>['columns'] = [
  {
    title: '类型',
    dataIndex: 'type',
    width: 100,
    render: (val: string) => <Tag>{val}</Tag>,
  },
  { title: '事件', dataIndex: 'title', width: 200 },
  { title: '详情', dataIndex: 'detail', ellipsis: true },
  { title: '时间', dataIndex: 'createdAt', width: 160 },
];
