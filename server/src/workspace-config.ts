export type WorkspaceGroupKey =
  | 'sales'
  | 'common'
  | 'aiService'
  | 'cardWarehouse'
  | 'distribution'
  | 'openPlatform'
  | 'fundCenter'
  | 'system';

export interface WorkspaceDefinition {
  featureKey: string;
  featureLabel: string;
  groupKey: WorkspaceGroupKey;
  groupLabel: string;
  statusTag: string;
  summaryLabels: [string, string, string];
  actionTitles: [string, string, string];
  ruleTitles: [string, string, string];
  insightTitles: [string, string];
}

const groupDefinitions: Record<
  WorkspaceGroupKey,
  Pick<
    WorkspaceDefinition,
    'groupLabel' | 'statusTag' | 'summaryLabels' | 'actionTitles' | 'ruleTitles' | 'insightTitles'
  >
> = {
  sales: {
    groupLabel: '销售管理',
    statusTag: '经营中',
    summaryLabels: ['待处理任务', '启用规则', '最近日志'],
    actionTitles: ['工作台入口', '规则执行', '结果回查'],
    ruleTitles: ['自动处理规则', '异常提醒规则', '人工复核规则'],
    insightTitles: ['当前模块目标', '建议下一步'],
  },
  common: {
    groupLabel: '常用功能',
    statusTag: '常用工具',
    summaryLabels: ['启用状态', '触发规则', '最近日志'],
    actionTitles: ['功能入口', '策略设置', '结果追踪'],
    ruleTitles: ['启用规则', '频次规则', '异常规则'],
    insightTitles: ['当前模块目标', '建议下一步'],
  },
  aiService: {
    groupLabel: 'AI 客服',
    statusTag: '辅助处理中',
    summaryLabels: ['待处理会话', '策略开关', '最近留痕'],
    actionTitles: ['会话处理', '知识维护', '策略校验'],
    ruleTitles: ['自动答复规则', '风险转人工规则', '回复边界规则'],
    insightTitles: ['当前模块目标', '建议下一步'],
  },
  cardWarehouse: {
    groupLabel: '卡密仓库',
    statusTag: '库存联动',
    summaryLabels: ['待处理任务', '库存规则', '最近日志'],
    actionTitles: ['库存看板', '模板同步', '交付记录'],
    ruleTitles: ['库存预警规则', '发货校验规则', '异常回收规则'],
    insightTitles: ['当前模块目标', '建议下一步'],
  },
  distribution: {
    groupLabel: '闲鱼分销',
    statusTag: '协同处理中',
    summaryLabels: ['待处理任务', '协同规则', '最近日志'],
    actionTitles: ['货源面板', '供货协同', '对账结果'],
    ruleTitles: ['协同规则', '价格规则', '异常提醒规则'],
    insightTitles: ['当前模块目标', '建议下一步'],
  },
  openPlatform: {
    groupLabel: '开放平台',
    statusTag: '接入运行中',
    summaryLabels: ['待处理任务', '授权规则', '最近日志'],
    actionTitles: ['接入管理', '权限校验', '调用追踪'],
    ruleTitles: ['授权规则', '白名单规则', '告警规则'],
    insightTitles: ['当前模块目标', '建议下一步'],
  },
  fundCenter: {
    groupLabel: '资金中心',
    statusTag: '账务处理中',
    summaryLabels: ['待处理任务', '账务规则', '最近日志'],
    actionTitles: ['账务看板', '审批处理', '对账结果'],
    ruleTitles: ['审批规则', '对账规则', '风险提醒规则'],
    insightTitles: ['当前模块目标', '建议下一步'],
  },
  system: {
    groupLabel: '系统其他',
    statusTag: '系统维护中',
    summaryLabels: ['待处理任务', '配置规则', '最近日志'],
    actionTitles: ['配置入口', '流程处理', '变更记录'],
    ruleTitles: ['配置规则', '审核规则', '通知规则'],
    insightTitles: ['当前模块目标', '建议下一步'],
  },
};

const workspaceSeeds: Array<Pick<WorkspaceDefinition, 'featureKey' | 'featureLabel' | 'groupKey'>> = [
  { featureKey: 'move', featureLabel: '搬家', groupKey: 'sales' },
  { featureKey: 'school', featureLabel: '学堂', groupKey: 'sales' },
  { featureKey: 'limited-purchase', featureLabel: '限购', groupKey: 'common' },
  { featureKey: 'fish-coin', featureLabel: '闲鱼币', groupKey: 'common' },
  { featureKey: 'ai-service', featureLabel: '客服', groupKey: 'aiService' },
  { featureKey: 'ai-bargain', featureLabel: '议价', groupKey: 'aiService' },
  { featureKey: 'card-types', featureLabel: '卡种', groupKey: 'cardWarehouse' },
  { featureKey: 'card-delivery', featureLabel: '发货', groupKey: 'cardWarehouse' },
  { featureKey: 'card-combos', featureLabel: '组合', groupKey: 'cardWarehouse' },
  { featureKey: 'card-templates', featureLabel: '模板', groupKey: 'cardWarehouse' },
  { featureKey: 'card-records', featureLabel: '记录', groupKey: 'cardWarehouse' },
  { featureKey: 'card-trash', featureLabel: '回收站', groupKey: 'cardWarehouse' },
  { featureKey: 'distribution-source', featureLabel: '找货', groupKey: 'distribution' },
  { featureKey: 'distribution-supply', featureLabel: '供货', groupKey: 'distribution' },
  { featureKey: 'open-apps', featureLabel: '应用', groupKey: 'openPlatform' },
  { featureKey: 'open-docs', featureLabel: '文档', groupKey: 'openPlatform' },
  { featureKey: 'open-logs', featureLabel: '日志', groupKey: 'openPlatform' },
  { featureKey: 'open-settings', featureLabel: '设置', groupKey: 'openPlatform' },
  { featureKey: 'open-whitelist', featureLabel: '白名单', groupKey: 'openPlatform' },
  { featureKey: 'fund-accounts', featureLabel: '账户', groupKey: 'fundCenter' },
  { featureKey: 'fund-bills', featureLabel: '账单', groupKey: 'fundCenter' },
  { featureKey: 'fund-withdrawals', featureLabel: '提现', groupKey: 'fundCenter' },
  { featureKey: 'fund-deposit', featureLabel: '保证金', groupKey: 'fundCenter' },
  { featureKey: 'fund-orders', featureLabel: '订购', groupKey: 'fundCenter' },
  { featureKey: 'fund-agents', featureLabel: '代理商', groupKey: 'fundCenter' },
  { featureKey: 'system-accounts', featureLabel: '账号', groupKey: 'system' },
  { featureKey: 'system-addresses', featureLabel: '地址', groupKey: 'system' },
  { featureKey: 'system-freight', featureLabel: '运费', groupKey: 'system' },
  { featureKey: 'system-monitoring', featureLabel: '监控', groupKey: 'system' },
  { featureKey: 'system-configs', featureLabel: '配置', groupKey: 'system' },
  { featureKey: 'system-applications', featureLabel: '申请', groupKey: 'system' },
  { featureKey: 'system-client', featureLabel: '客户端', groupKey: 'system' },
];

export const workspaceDefinitions: WorkspaceDefinition[] = workspaceSeeds.map((item) => {
  const group = groupDefinitions[item.groupKey];

  return {
    ...item,
    ...group,
    actionTitles: group.actionTitles.map((title) => `${item.featureLabel}${title}`) as [
      string,
      string,
      string,
    ],
    ruleTitles: group.ruleTitles.map((title) => `${item.featureLabel}${title}`) as [
      string,
      string,
      string,
    ],
    insightTitles: group.insightTitles,
  };
});

export function getWorkspaceDefinition(featureKey: string) {
  return workspaceDefinitions.find((item) => item.featureKey === featureKey);
}
