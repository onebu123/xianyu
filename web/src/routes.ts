// 统一路由配置表
// 新增页面只需在此文件添加一行配置即可，无需修改 App.tsx

import { lazy, type ComponentType } from 'react';

export interface RouteConfig {
  /** 路由路径 */
  path: string;
  /** 懒加载的页面组件 */
  component: React.LazyExoticComponent<ComponentType>;
}

/**
 * 创建懒加载页面组件的辅助函数
 * @param importFn - 动态 import 函数
 * @param exportName - 模块中导出的组件名称
 */
function lazyPage(
  importFn: () => Promise<Record<string, ComponentType>>,
  exportName: string,
) {
  return lazy(() =>
    importFn().then((module) => ({ default: module[exportName] })),
  );
}

// ─── 核心页面路由 ─────────────────────────────────────────

export const coreRoutes: RouteConfig[] = [
  { path: '/dashboard', component: lazyPage(() => import('./pages/DashboardPage'), 'DashboardPage') },
  { path: '/stores', component: lazyPage(() => import('./pages/StoresPage'), 'StoresPage') },
  { path: '/orders', component: lazyPage(() => import('./pages/OrdersPage'), 'OrdersPage') },
  { path: '/products', component: lazyPage(() => import('./pages/ProductsPage'), 'ProductsPage') },
  { path: '/after-sale', component: lazyPage(() => import('./pages/AfterSalePage'), 'AfterSalePage') },
  { path: '/reports', component: lazyPage(() => import('./pages/ReportsPage'), 'ReportsPage') },
  { path: '/customers', component: lazyPage(() => import('./pages/CustomersPage'), 'CustomersPage') },
];

// ─── 工作台页面路由 ────────────────────────────────────────

export const workspaceRoutes: RouteConfig[] = [
  // 发卡与卡密
  { path: '/workspace/faka', component: lazyPage(() => import('./pages/FakaPage'), 'FakaPage') },
  { path: '/workspace/card-types', component: lazyPage(() => import('./pages/CardTypesPage'), 'CardTypesPage') },
  { path: '/workspace/card-delivery', component: lazyPage(() => import('./pages/CardDeliveryPage'), 'CardDeliveryPage') },
  { path: '/workspace/card-combos', component: lazyPage(() => import('./pages/CardCombosPage'), 'CardCombosPage') },
  { path: '/workspace/card-templates', component: lazyPage(() => import('./pages/CardTemplatesPage'), 'CardTemplatesPage') },
  { path: '/workspace/card-records', component: lazyPage(() => import('./pages/CardRecordsPage'), 'CardRecordsPage') },
  { path: '/workspace/card-trash', component: lazyPage(() => import('./pages/CardTrashPage'), 'CardTrashPage') },

  // AI 服务
  { path: '/workspace/ai-service', component: lazyPage(() => import('./pages/ChatPage'), 'ChatPage') },
  { path: '/workspace/ai-bargain', component: lazyPage(() => import('./pages/AiBargainPage'), 'AiBargainPage') },

  // 分销
  { path: '/workspace/distribution-source', component: lazyPage(() => import('./pages/DistributionSourcePage'), 'DistributionSourcePage') },
  { path: '/workspace/distribution-supply', component: lazyPage(() => import('./pages/DistributionSupplyPage'), 'DistributionSupplyPage') },

  // 资金中心
  { path: '/workspace/fund-accounts', component: lazyPage(() => import('./pages/FundAccountsPage'), 'FundAccountsPage') },
  { path: '/workspace/fund-bills', component: lazyPage(() => import('./pages/FundBillsPage'), 'FundBillsPage') },
  { path: '/workspace/fund-withdrawals', component: lazyPage(() => import('./pages/FundWithdrawalsPage'), 'FundWithdrawalsPage') },
  { path: '/workspace/fund-deposit', component: lazyPage(() => import('./pages/FundDepositPage'), 'FundDepositPage') },
  { path: '/workspace/fund-orders', component: lazyPage(() => import('./pages/FundOrdersPage'), 'FundOrdersPage') },
  { path: '/workspace/fund-agents', component: lazyPage(() => import('./pages/FundAgentsPage'), 'FundAgentsPage') },

  // 运营工具
  { path: '/workspace/limited-purchase', component: lazyPage(() => import('./pages/LimitedPurchasePage'), 'LimitedPurchasePage') },
  { path: '/workspace/fish-coin', component: lazyPage(() => import('./pages/FishCoinPage'), 'FishCoinPage') },
  { path: '/workspace/move', component: lazyPage(() => import('./pages/MovePage'), 'MovePage') },
  { path: '/workspace/school', component: lazyPage(() => import('./pages/SchoolPage'), 'SchoolPage') },

  // 开放平台
  { path: '/workspace/open-apps', component: lazyPage(() => import('./pages/OpenAppsPage'), 'OpenAppsPage') },
  { path: '/workspace/open-docs', component: lazyPage(() => import('./pages/OpenDocsPage'), 'OpenDocsPage') },
  { path: '/workspace/open-logs', component: lazyPage(() => import('./pages/OpenLogsPage'), 'OpenLogsPage') },
  { path: '/workspace/open-settings', component: lazyPage(() => import('./pages/OpenSettingsPage'), 'OpenSettingsPage') },
  { path: '/workspace/open-whitelist', component: lazyPage(() => import('./pages/OpenWhitelistPage'), 'OpenWhitelistPage') },

  // 系统管理
  { path: '/workspace/system-accounts', component: lazyPage(() => import('./pages/SystemAccountsPage'), 'SystemAccountsPage') },
  { path: '/workspace/system-addresses', component: lazyPage(() => import('./pages/SystemAddressesPage'), 'SystemAddressesPage') },
  { path: '/workspace/system-freight', component: lazyPage(() => import('./pages/SystemFreightPage'), 'SystemFreightPage') },
  { path: '/workspace/system-monitoring', component: lazyPage(() => import('./pages/SystemMonitoringPage'), 'SystemMonitoringPage') },
  { path: '/workspace/system-configs', component: lazyPage(() => import('./pages/SystemConfigsPage'), 'SystemConfigsPage') },
  { path: '/workspace/system-applications', component: lazyPage(() => import('./pages/SystemApplicationsPage'), 'SystemApplicationsPage') },
  { path: '/workspace/system-client', component: lazyPage(() => import('./pages/SystemClientPage'), 'SystemClientPage') },
];

// ─── 所有受保护路由 ─────────────────────────────────────────

export const protectedRoutes: RouteConfig[] = [...coreRoutes, ...workspaceRoutes];

export const platformRoutes: RouteConfig[] = [
  {
    path: '/platform/tenants',
    component: lazyPage(() => import('./pages/PlatformTenantsPage'), 'PlatformTenantsPage'),
  },
  {
    path: '/platform/security',
    component: lazyPage(() => import('./pages/PlatformSecurityPage'), 'PlatformSecurityPage'),
  },
  {
    path: '/platform/provisioning-jobs',
    component: lazyPage(
      () => import('./pages/PlatformProvisioningJobsPage'),
      'PlatformProvisioningJobsPage',
    ),
  },
];

// 通配工作台路由（匹配 /workspace/:featureKey）
export const FeatureWorkspacePage = lazyPage(
  () => import('./pages/FeatureWorkspacePage'),
  'FeatureWorkspacePage',
);

// 特殊弹窗路由
export const StoreAuthorizePage = lazyPage(
  () => import('./pages/StoreAuthorizePage'),
  'StoreAuthorizePage',
);

// 登录页
export const LoginPage = lazyPage(
  () => import('./pages/LoginPage'),
  'LoginPage',
);

export const TenantSelectPage = lazyPage(
  () => import('./pages/TenantSelectPage'),
  'TenantSelectPage',
);
