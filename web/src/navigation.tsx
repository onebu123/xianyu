import type { ReactNode } from 'react';
import {
  ApiOutlined,
  AppstoreOutlined,
  AreaChartOutlined,
  BankOutlined,
  BookOutlined,
  CarOutlined,
  CreditCardOutlined,
  CustomerServiceOutlined,
  DeleteOutlined,
  DeploymentUnitOutlined,
  DollarOutlined,
  EnvironmentOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  FundProjectionScreenOutlined,
  GiftOutlined,
  GlobalOutlined,
  SafetyOutlined,
  SettingOutlined,
  ShopOutlined,
  ShoppingCartOutlined,
  ShoppingOutlined,
  SolutionOutlined,
  SwapOutlined,
  ToolOutlined,
  WalletOutlined,
} from '@ant-design/icons';

export type WorkspaceGroupKey =
  | 'sales'
  | 'common'
  | 'aiService'
  | 'cardWarehouse'
  | 'distribution'
  | 'openPlatform'
  | 'fundCenter'
  | 'system';

export interface NavigationItem {
  key: string;
  label: string;
  path: string;
  description: string;
  icon: ReactNode;
  kind: 'core' | 'workspace';
  workspaceKey?: string;
}

export interface NavigationGroup {
  key: WorkspaceGroupKey;
  label: string;
  icon: ReactNode;
  items: NavigationItem[];
}

export interface WorkspaceBlueprint {
  summaryLabels: string[];
  actionTitles: string[];
  checklist: string[];
}

export const workspaceBlueprints: Record<WorkspaceGroupKey, WorkspaceBlueprint> = {
  sales: {
    summaryLabels: ['待处理任务', '自动化策略', '最近更新'],
    actionTitles: ['工作台入口', '规则配置', '执行记录'],
    checklist: ['确认店铺范围', '检查处理规则', '核对最近执行结果'],
  },
  common: {
    summaryLabels: ['启用状态', '触发规则', '覆盖店铺'],
    actionTitles: ['功能开关', '策略设置', '结果追踪'],
    checklist: ['确认生效范围', '配置触发条件', '保留异常记录'],
  },
  aiService: {
    summaryLabels: ['待处理会话', '策略开关', '最近留痕'],
    actionTitles: ['会话处理', '知识维护', '风险控制'],
    checklist: ['检查 AI 开关', '复核高风险会话', '确认知识库与话术是否最新'],
  },
  cardWarehouse: {
    summaryLabels: ['库存状态', '模板数量', '异常记录'],
    actionTitles: ['库存管理', '模板配置', '交付追踪'],
    checklist: ['同步库存数量', '检查模板规则', '清理异常数据'],
  },
  distribution: {
    summaryLabels: ['供货状态', '分销商品', '协同进度'],
    actionTitles: ['找货面板', '供货面板', '对账记录'],
    checklist: ['确认商品来源', '核对供货价格', '同步最新分销状态'],
  },
  openPlatform: {
    summaryLabels: ['应用状态', '调用配额', '告警数量'],
    actionTitles: ['接入管理', '文档与密钥', '调用日志'],
    checklist: ['校验应用配置', '检查权限范围', '保留关键日志'],
  },
  fundCenter: {
    summaryLabels: ['资金快照', '异常账单', '审批进度'],
    actionTitles: ['账户总览', '流水核对', '审批处理'],
    checklist: ['确认账单周期', '核对异常流水', '处理待审批事项'],
  },
  system: {
    summaryLabels: ['配置项', '待审核项', '运行状态'],
    actionTitles: ['基础配置', '流程处理', '交付支持'],
    checklist: ['确认配置版本', '检查待办流程', '记录最近变更'],
  },
};

export const navigationGroups: NavigationGroup[] = [
  {
    key: 'sales',
    label: '销售管理',
    icon: <AreaChartOutlined />,
    items: [
      {
        key: 'dashboard',
        label: '统计',
        path: '/dashboard',
        description: '按目标站的首页结构整合待处理、今日统计、商品统计、订单统计、售后统计与常用功能。',
        icon: <AreaChartOutlined />,
        kind: 'core',
      },
      {
        key: 'stores',
        label: '店铺',
        path: '/stores',
        description: '查看各店铺销售贡献、转化率、动销情况与库存压力。',
        icon: <ShopOutlined />,
        kind: 'core',
      },
      {
        key: 'products',
        label: '商品',
        path: '/products',
        description: '分析商品销量、库存、分类表现和动销排行。',
        icon: <ShoppingOutlined />,
        kind: 'core',
      },
      {
        key: 'orders',
        label: '订单',
        path: '/orders',
        description: '查看订单明细、状态分布、导出与发货效率。',
        icon: <ShoppingCartOutlined />,
        kind: 'core',
      },
      {
        key: 'afterSale',
        label: '售后',
        path: '/after-sale',
        description: '跟进售后状态、退款金额、处理进度与售后订单。',
        icon: <SafetyOutlined />,
        kind: 'core',
      },
      {
        key: 'move',
        label: '搬家',
        path: '/workspace/move',
        description: '用于商品搬家、迁移任务编排与执行跟踪。',
        icon: <SwapOutlined />,
        kind: 'workspace',
        workspaceKey: 'move',
      },
      {
        key: 'school',
        label: '学堂',
        path: '/workspace/school',
        description: '沉淀操作指引、运营经验和功能使用说明。',
        icon: <BookOutlined />,
        kind: 'workspace',
        workspaceKey: 'school',
      },
    ],
  },
  {
    key: 'common',
    label: '常用功能',
    icon: <AppstoreOutlined />,
    items: [
      {
        key: 'limitedPurchase',
        label: '限购',
        path: '/workspace/limited-purchase',
        description: '配置限购规则、适用商品和触发条件。',
        icon: <ToolOutlined />,
        kind: 'workspace',
        workspaceKey: 'limited-purchase',
      },
      {
        key: 'coin',
        label: '闲鱼币',
        path: '/workspace/fish-coin',
        description: '管理币值规则、投放策略和兑换记录。',
        icon: <GiftOutlined />,
        kind: 'workspace',
        workspaceKey: 'fish-coin',
      },
    ],
  },
  {
    key: 'aiService',
    label: 'AI 客服',
    icon: <CustomerServiceOutlined />,
    items: [
      {
        key: 'aiService',
        label: '客服',
        path: '/workspace/ai-service',
        description: '处理 AI 自动答复、订单查询、售后建议、人工接管和知识库策略。',
        icon: <CustomerServiceOutlined />,
        kind: 'workspace',
        workspaceKey: 'ai-service',
      },
      {
        key: 'aiBargain',
        label: '议价',
        path: '/workspace/ai-bargain',
        description: '管理底价保护、议价策略、风险识别、人工接管和议价留痕统计。',
        icon: <DollarOutlined />,
        kind: 'workspace',
        workspaceKey: 'ai-bargain',
      },
    ],
  },
  {
    key: 'cardWarehouse',
    label: '卡密仓库',
    icon: <CreditCardOutlined />,
    items: [
      {
        key: 'cardType',
        label: '卡种',
        path: '/workspace/card-types',
        description: '维护卡种资料、库存数量与规格配置。',
        icon: <CreditCardOutlined />,
        kind: 'workspace',
        workspaceKey: 'card-types',
      },
      {
        key: 'cardDelivery',
        label: '发货',
        path: '/workspace/card-delivery',
        description: '跟踪卡密发货、失败重试与交付记录。',
        icon: <CarOutlined />,
        kind: 'workspace',
        workspaceKey: 'card-delivery',
      },
      {
        key: 'cardCombo',
        label: '组合',
        path: '/workspace/card-combos',
        description: '设置组合售卖规则与组合库存联动。',
        icon: <DeploymentUnitOutlined />,
        kind: 'workspace',
        workspaceKey: 'card-combos',
      },
      {
        key: 'cardTemplate',
        label: '模板',
        path: '/workspace/card-templates',
        description: '管理交付模板、消息模板和展示格式。',
        icon: <FileTextOutlined />,
        kind: 'workspace',
        workspaceKey: 'card-templates',
      },
      {
        key: 'cardRecord',
        label: '记录',
        path: '/workspace/card-records',
        description: '查看卡密领取、发货和回收全链路记录。',
        icon: <FileSearchOutlined />,
        kind: 'workspace',
        workspaceKey: 'card-records',
      },
      {
        key: 'cardTrash',
        label: '回收站',
        path: '/workspace/card-trash',
        description: '处理误删卡密、回收记录与二次恢复。',
        icon: <DeleteOutlined />,
        kind: 'workspace',
        workspaceKey: 'card-trash',
      },
    ],
  },
  {
    key: 'distribution',
    label: '闲鱼分销',
    icon: <DeploymentUnitOutlined />,
    items: [
      {
        key: 'sourceGoods',
        label: '找货',
        path: '/workspace/distribution-source',
        description: '维护货源池、选品规则和分销候选商品。',
        icon: <GlobalOutlined />,
        kind: 'workspace',
        workspaceKey: 'distribution-source',
      },
      {
        key: 'supplyGoods',
        label: '供货',
        path: '/workspace/distribution-supply',
        description: '管理供货商品、供货价格和对账进度。',
        icon: <DeploymentUnitOutlined />,
        kind: 'workspace',
        workspaceKey: 'distribution-supply',
      },
    ],
  },
  {
    key: 'openPlatform',
    label: '开放平台',
    icon: <ApiOutlined />,
    items: [
      {
        key: 'openApps',
        label: '应用',
        path: '/workspace/open-apps',
        description: '查看应用清单、接入状态和授权信息。',
        icon: <ApiOutlined />,
        kind: 'workspace',
        workspaceKey: 'open-apps',
      },
      {
        key: 'openDocs',
        label: '文档',
        path: '/workspace/open-docs',
        description: '维护接口文档、接入指南和字段说明。',
        icon: <BookOutlined />,
        kind: 'workspace',
        workspaceKey: 'open-docs',
      },
      {
        key: 'openLogs',
        label: '日志',
        path: '/workspace/open-logs',
        description: '查看接口调用日志、错误码与重试记录。',
        icon: <FileSearchOutlined />,
        kind: 'workspace',
        workspaceKey: 'open-logs',
      },
      {
        key: 'openSettings',
        label: '设置',
        path: '/workspace/open-settings',
        description: '配置密钥、回调地址与调用白名单。',
        icon: <SettingOutlined />,
        kind: 'workspace',
        workspaceKey: 'open-settings',
      },
      {
        key: 'openWhitelist',
        label: '白名单',
        path: '/workspace/open-whitelist',
        description: '管理调用来源、IP 白名单和权限生效范围。',
        icon: <SafetyOutlined />,
        kind: 'workspace',
        workspaceKey: 'open-whitelist',
      },
    ],
  },
  {
    key: 'fundCenter',
    label: '资金中心',
    icon: <WalletOutlined />,
    items: [
      {
        key: 'fundAccount',
        label: '账户',
        path: '/workspace/fund-accounts',
        description: '查看可用余额、冻结资金和账户状态。',
        icon: <WalletOutlined />,
        kind: 'workspace',
        workspaceKey: 'fund-accounts',
      },
      {
        key: 'fundBill',
        label: '账单',
        path: '/workspace/fund-bills',
        description: '核对流水、对账单和账务异常。',
        icon: <BankOutlined />,
        kind: 'workspace',
        workspaceKey: 'fund-bills',
      },
      {
        key: 'fundWithdraw',
        label: '提现',
        path: '/workspace/fund-withdrawals',
        description: '处理提现申请、到账进度和审批记录。',
        icon: <DollarOutlined />,
        kind: 'workspace',
        workspaceKey: 'fund-withdrawals',
      },
      {
        key: 'fundDeposit',
        label: '保证金',
        path: '/workspace/fund-deposit',
        description: '查看保证金状态、变更记录和风险提示。',
        icon: <SafetyOutlined />,
        kind: 'workspace',
        workspaceKey: 'fund-deposit',
      },
      {
        key: 'fundSubscription',
        label: '订购',
        path: '/workspace/fund-orders',
        description: '管理套餐订购、续费计划和服务周期。',
        icon: <AppstoreOutlined />,
        kind: 'workspace',
        workspaceKey: 'fund-orders',
      },
      {
        key: 'fundAgent',
        label: '代理商',
        path: '/workspace/fund-agents',
        description: '维护代理商层级、结算方式和返佣记录。',
        icon: <SolutionOutlined />,
        kind: 'workspace',
        workspaceKey: 'fund-agents',
      },
    ],
  },
  {
    key: 'system',
    label: '系统其他',
    icon: <SettingOutlined />,
    items: [
      {
        key: 'systemAccount',
        label: '账号',
        path: '/workspace/system-accounts',
        description: '管理账号权限、角色分配和登录安全。',
        icon: <SolutionOutlined />,
        kind: 'workspace',
        workspaceKey: 'system-accounts',
      },
      {
        key: 'systemAddress',
        label: '地址',
        path: '/workspace/system-addresses',
        description: '维护收发货地址、默认地址与地址模板。',
        icon: <EnvironmentOutlined />,
        kind: 'workspace',
        workspaceKey: 'system-addresses',
      },
      {
        key: 'systemFreight',
        label: '运费',
        path: '/workspace/system-freight',
        description: '配置运费模板、包邮规则和地区差价。',
        icon: <CarOutlined />,
        kind: 'workspace',
        workspaceKey: 'system-freight',
      },
      {
        key: 'systemMonitoring',
        label: '监控',
        path: '/workspace/system-monitoring',
        description: '查看告警、任务监控、备份归档和恢复演练记录。',
        icon: <ToolOutlined />,
        kind: 'workspace',
        workspaceKey: 'system-monitoring',
      },
      {
        key: 'systemConfig',
        label: '配置',
        path: '/workspace/system-configs',
        description: '维护系统配置、参数开关和环境状态。',
        icon: <SettingOutlined />,
        kind: 'workspace',
        workspaceKey: 'system-configs',
      },
      {
        key: 'systemApplication',
        label: '申请',
        path: '/workspace/system-applications',
        description: '查看待审批申请、审核结论和处理记录。',
        icon: <FileTextOutlined />,
        kind: 'workspace',
        workspaceKey: 'system-applications',
      },
      {
        key: 'systemClient',
        label: '客户端',
        path: '/workspace/system-client',
        description: '维护客户端版本、下载入口与更新说明。',
        icon: <FundProjectionScreenOutlined />,
        kind: 'workspace',
        workspaceKey: 'system-client',
      },
      {
        key: 'reports',
        label: '报表',
        path: '/reports',
        description: '汇总订单导出、经营摘要与经营周报。',
        icon: <FileTextOutlined />,
        kind: 'core',
      },
    ],
  },
];

export const navigationItems = navigationGroups.flatMap((group) => group.items);

export function findNavigationItem(pathname: string) {
  return navigationItems.find((item) => pathname === item.path || pathname.startsWith(`${item.path}/`));
}
