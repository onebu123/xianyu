import type { SystemUserRole } from './types.js';

export const systemUserRoles = ['admin', 'operator', 'support', 'finance'] as const satisfies readonly SystemUserRole[];

export const workspaceAccessPolicy: Record<
  string,
  { view: SystemUserRole[]; manage: SystemUserRole[] }
> = {
  move: { view: ['admin', 'operator'], manage: ['admin', 'operator'] },
  school: { view: ['admin', 'operator', 'support', 'finance'], manage: ['admin', 'operator'] },
  'limited-purchase': { view: ['admin', 'operator'], manage: ['admin', 'operator'] },
  'fish-coin': { view: ['admin', 'operator'], manage: ['admin', 'operator'] },
  'ai-service': { view: ['admin', 'operator', 'support'], manage: ['admin', 'operator', 'support'] },
  'ai-bargain': { view: ['admin', 'operator', 'support'], manage: ['admin', 'operator', 'support'] },
  'card-types': { view: ['admin', 'operator'], manage: ['admin', 'operator'] },
  'card-delivery': { view: ['admin', 'operator'], manage: ['admin', 'operator'] },
  'card-combos': { view: ['admin', 'operator'], manage: ['admin', 'operator'] },
  'card-templates': { view: ['admin', 'operator'], manage: ['admin', 'operator'] },
  'card-records': { view: ['admin', 'operator'], manage: ['admin', 'operator'] },
  'card-trash': { view: ['admin', 'operator'], manage: ['admin', 'operator'] },
  'distribution-source': { view: ['admin', 'operator'], manage: ['admin', 'operator'] },
  'distribution-supply': { view: ['admin', 'operator'], manage: ['admin', 'operator'] },
  'open-apps': { view: ['admin', 'operator'], manage: ['admin', 'operator'] },
  'open-docs': { view: ['admin', 'operator'], manage: ['admin', 'operator'] },
  'open-logs': { view: ['admin'], manage: ['admin'] },
  'open-settings': { view: ['admin'], manage: ['admin'] },
  'open-whitelist': { view: ['admin'], manage: ['admin'] },
  'fund-accounts': { view: ['admin', 'finance'], manage: ['admin', 'finance'] },
  'fund-bills': { view: ['admin', 'finance'], manage: ['admin', 'finance'] },
  'fund-withdrawals': { view: ['admin', 'finance'], manage: ['admin', 'finance'] },
  'fund-deposit': { view: ['admin', 'finance'], manage: ['admin', 'finance'] },
  'fund-orders': { view: ['admin', 'finance'], manage: ['admin', 'finance'] },
  'fund-agents': { view: ['admin', 'finance'], manage: ['admin', 'finance'] },
  'system-accounts': { view: ['admin'], manage: ['admin'] },
  'system-addresses': { view: ['admin', 'operator'], manage: ['admin', 'operator'] },
  'system-freight': { view: ['admin', 'operator'], manage: ['admin', 'operator'] },
  'system-monitoring': { view: ['admin', 'operator'], manage: ['admin', 'operator'] },
  'system-configs': { view: ['admin'], manage: ['admin'] },
  'system-applications': { view: ['admin'], manage: ['admin'] },
  'system-client': { view: ['admin'], manage: ['admin'] },
};

export const routeAccessPolicy = {
  dashboard: ['admin', 'operator', 'support', 'finance'] as SystemUserRole[],
  stores: ['admin', 'operator'] as SystemUserRole[],
  products: ['admin', 'operator'] as SystemUserRole[],
  orders: ['admin', 'operator', 'support', 'finance'] as SystemUserRole[],
  afterSale: ['admin', 'operator', 'support'] as SystemUserRole[],
  reports: ['admin', 'operator', 'finance'] as SystemUserRole[],
  customers: ['admin', 'operator', 'support'] as SystemUserRole[],
  exportOrders: ['admin', 'operator', 'finance'] as SystemUserRole[],
  manageFulfillment: ['admin', 'operator', 'support'] as SystemUserRole[],
  manageAfterSale: ['admin', 'operator', 'support'] as SystemUserRole[],
  manageStores: ['admin', 'operator'] as SystemUserRole[],
  manageUsers: ['admin'] as SystemUserRole[],
  manageSecureSettings: ['admin'] as SystemUserRole[],
  viewAuditLogs: ['admin'] as SystemUserRole[],
  approveWithdrawals: ['admin', 'finance'] as SystemUserRole[],
} as const;

export function canAccessRoles(role: SystemUserRole, allowedRoles: readonly SystemUserRole[]) {
  return allowedRoles.includes(role);
}

export function canViewWorkspaceFeature(role: SystemUserRole, featureKey: string) {
  const policy = workspaceAccessPolicy[featureKey];
  return policy ? canAccessRoles(role, policy.view) : false;
}

export function canManageWorkspaceFeature(role: SystemUserRole, featureKey: string) {
  const policy = workspaceAccessPolicy[featureKey];
  return policy ? canAccessRoles(role, policy.manage) : false;
}
