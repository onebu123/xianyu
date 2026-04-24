import type { PlatformUserRole, SystemUserRole } from './api';
import type { NavigationItem } from './navigation';

export type AppUserRole = SystemUserRole;
export type AppPlatformRole = PlatformUserRole;

const roleLabelMap: Record<AppUserRole, string> = {
  admin: '管理员',
  operator: '运营',
  support: '客服',
  finance: '财务',
};

const platformRoleLabelMap: Record<AppPlatformRole, string> = {
  platform_admin: '平台管理员',
  platform_operator: '平台运营',
};

const workspaceAccessPolicy: Record<string, { view: AppUserRole[]; manage: AppUserRole[] }> = {
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

const coreAccessPolicy: Record<string, AppUserRole[]> = {
  '/dashboard': ['admin', 'operator', 'support', 'finance'],
  '/stores': ['admin', 'operator'],
  '/products': ['admin', 'operator'],
  '/orders': ['admin', 'operator', 'support', 'finance'],
  '/after-sale': ['admin', 'operator', 'support'],
  '/reports': ['admin', 'operator', 'finance'],
  '/customers': ['admin', 'operator', 'support'],
};

function hasRole(role: AppUserRole | null | undefined, allowedRoles: readonly AppUserRole[]) {
  return Boolean(role && allowedRoles.includes(role));
}

function extractWorkspaceFeature(pathname: string) {
  if (!pathname.startsWith('/workspace/')) {
    return null;
  }

  const [, , featureKey] = pathname.split('/');
  return featureKey || null;
}

export function getRoleLabel(role: AppUserRole | null | undefined) {
  return role ? roleLabelMap[role] : '未知角色';
}

export function getPlatformRoleLabel(role: AppPlatformRole | null | undefined) {
  return role ? platformRoleLabelMap[role] : '未知平台角色';
}

export function getFirstAccessiblePath(role: AppUserRole | null | undefined) {
  if (!role) {
    return '/login';
  }

  if (hasRole(role, coreAccessPolicy['/dashboard'])) {
    return '/dashboard';
  }

  const firstCore = Object.entries(coreAccessPolicy).find(([, allowedRoles]) =>
    hasRole(role, allowedRoles),
  );
  return firstCore?.[0] ?? '/dashboard';
}

export function canAccessPath(role: AppUserRole | null | undefined, pathname: string) {
  if (!role) {
    return false;
  }

  if (pathname.startsWith('/stores/connect/')) {
    return hasRole(role, coreAccessPolicy['/stores']);
  }

  const workspaceFeature = extractWorkspaceFeature(pathname);
  if (workspaceFeature) {
    const policy = workspaceAccessPolicy[workspaceFeature];
    return policy ? hasRole(role, policy.view) : false;
  }

  const matchedEntry = Object.entries(coreAccessPolicy).find(([key]) =>
    pathname === key || pathname.startsWith(`${key}/`),
  );
  if (matchedEntry) {
    return hasRole(role, matchedEntry[1]);
  }

  return true;
}

export function canAccessNavigationItem(
  role: AppUserRole | null | undefined,
  item: NavigationItem,
) {
  if (!role) {
    return false;
  }

  if (item.kind === 'workspace' && item.workspaceKey) {
    return hasRole(role, workspaceAccessPolicy[item.workspaceKey]?.view ?? []);
  }

  return canAccessPath(role, item.path);
}

export function canManageWorkspace(role: AppUserRole | null | undefined, featureKey: string) {
  if (!role) {
    return false;
  }

  return hasRole(role, workspaceAccessPolicy[featureKey]?.manage ?? []);
}

export function canExportOrders(role: AppUserRole | null | undefined) {
  return hasRole(role, ['admin', 'operator', 'finance']);
}

export function canExportReports(role: AppUserRole | null | undefined) {
  return hasRole(role, ['admin', 'operator', 'finance']);
}

export function canManageFulfillment(role: AppUserRole | null | undefined) {
  return hasRole(role, ['admin', 'operator', 'support']);
}

export function canSyncOrderData(role: AppUserRole | null | undefined) {
  return hasRole(role, ['admin', 'operator']);
}

export function canManageAfterSale(role: AppUserRole | null | undefined) {
  return hasRole(role, ['admin', 'operator', 'support']);
}

export function canManageUsers(role: AppUserRole | null | undefined) {
  return role === 'admin';
}

export function canManageSecureSettings(role: AppUserRole | null | undefined) {
  return role === 'admin';
}

export function canViewAuditLogs(role: AppUserRole | null | undefined) {
  return role === 'admin';
}

export function canApproveWithdrawals(role: AppUserRole | null | undefined) {
  return hasRole(role, ['admin', 'finance']);
}
