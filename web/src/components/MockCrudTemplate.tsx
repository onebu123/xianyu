import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { PageContainer, ProTable } from '@ant-design/pro-components';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { Alert, Button, Modal } from 'antd';
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';

import { useWorkspaceData, useOverviewSummary } from '../hooks/useWorkspaceData';
import { SummaryCards } from './SummaryCards';

type MockCrudRow = {
  id: string | number;
} & Record<string, unknown>;

export interface MockCrudConfig<T extends MockCrudRow = MockCrudRow> {
  featureKey: string;
  title: string;
  subTitle: string;
  icon: ReactNode;
  alertMessage: string;
  alertDescription: string;
  alertType?: 'info' | 'warning';
  columns: ProColumns<T>[];
  mockData: T[];
}

/**
 * 通用 CRUD 占位模板，用于给缺失后端的骨架页提供交互体验
 */
export function MockCrudTemplate<T extends MockCrudRow>({ config }: { config: MockCrudConfig<T> }) {
  const { overview, loading: overviewLoading, reload } = useWorkspaceData(
    config.featureKey,
    false,
  );
  const summary = useOverviewSummary(overview);
  const actionRef = useRef<ActionType>(null);
  
  const [data] = useState<T[]>(config.mockData);

  const handleCreate = () => {
    Modal.info({
      title: '演示环境说明',
      content: '当前为演示骨架页，新增操作尚未与后端 API 对接。这里可以放置具体的业务提交表单。',
      okText: '知道了',
    });
  };

  return (
    <PageContainer
      title={config.title}
      subTitle={config.subTitle}
      style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新工作台</Button>]}
    >
      <div className="page-grid">
        <Alert type={config.alertType ?? 'info'} showIcon icon={config.icon} message={config.alertMessage} description={config.alertDescription} />
        
        {summary.length > 0 && <SummaryCards items={summary} />}

        <ProTable<T>
          columns={config.columns}
          actionRef={actionRef}
          cardBordered
          dataSource={data}
          loading={overviewLoading}
          rowKey="id"
          search={{
            labelWidth: 'auto',
          }}
          options={{
            setting: {
              listsHeight: 400,
            },
          }}
          pagination={{
            pageSize: 10,
          }}
          dateFormatter="string"
          headerTitle="管理列表"
          toolBarRender={() => [
            <Button key="button" icon={<PlusOutlined />} onClick={handleCreate} type="primary">
              新增记录
            </Button>,
          ]}
        />
      </div>
    </PageContainer>
  );
}
