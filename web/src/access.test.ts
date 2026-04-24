import { describe, expect, it } from 'vitest';

import {
  canAccessNavigationItem,
  canAccessPath,
  canManageWorkspace,
  getFirstAccessiblePath,
  getPlatformRoleLabel,
  getRoleLabel,
} from './access';
import { navigationGroups } from './navigation';

describe('前端访问控制', () => {
  it('能够返回角色标签和首个可访问路径', () => {
    expect(getRoleLabel('admin')).toBe('管理员');
    expect(getPlatformRoleLabel('platform_admin')).toBe('平台管理员');
    expect(getFirstAccessiblePath('support')).toBe('/dashboard');
    expect(getFirstAccessiblePath(null)).toBe('/login');
  });

  it('能够按业务路径判断访问权限', () => {
    expect(canAccessPath('support', '/orders')).toBe(true);
    expect(canAccessPath('support', '/stores')).toBe(false);
    expect(canAccessPath('finance', '/workspace/fund-bills')).toBe(true);
    expect(canAccessPath('finance', '/workspace/open-settings')).toBe(false);
  });

  it('能够按导航项和工作台管理权限判断', () => {
    const storesItem = navigationGroups[0]?.items.find((item) => item.path === '/stores');
    const openSettingsItem = navigationGroups
      .flatMap((group) => group.items)
      .find((item) => item.path === '/workspace/open-settings');

    expect(storesItem && canAccessNavigationItem('operator', storesItem)).toBe(true);
    expect(openSettingsItem && canAccessNavigationItem('operator', openSettingsItem)).toBe(false);
    expect(canManageWorkspace('admin', 'open-settings')).toBe(true);
    expect(canManageWorkspace('support', 'ai-service')).toBe(true);
    expect(canManageWorkspace('support', 'card-delivery')).toBe(false);
  });
});
