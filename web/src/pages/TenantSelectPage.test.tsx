import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../test/render';
import { TenantSelectPage } from './TenantSelectPage';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  selectTenant: vi.fn(),
  authState: {
    memberships: [] as Array<{
      membership: {
        id: number;
        tenantId: number;
        platformUserId: number;
        membershipRole: 'owner' | 'admin' | 'member' | 'support';
        systemRole: 'admin' | 'operator' | 'support' | 'finance';
        status: 'active' | 'disabled';
        createdAt: string;
        updatedAt: string;
      };
      tenant: {
        id: number;
        tenantKey: string;
        tenantName: string;
        displayName: string;
        status: 'active' | 'provisioning' | 'suspended';
        businessDbPath: string;
        createdAt: string;
        updatedAt: string;
        provisionedAt: string | null;
        suspendedAt: string | null;
      };
    }>,
    platformUser: {
      id: 1,
      username: 'platform-admin',
      displayName: '平台管理员',
      role: 'platform_admin',
      status: 'active',
      createdAt: '2026-04-16T10:00:00.000Z',
      updatedAt: '2026-04-16T10:00:00.000Z',
      lastLoginAt: null,
      passwordChangedAt: null,
    },
  },
}));

vi.mock('../auth', () => ({
  useAuth: () => ({
    memberships: mocks.authState.memberships,
    platformUser: mocks.authState.platformUser,
    selectTenant: mocks.selectTenant,
  }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

describe('TenantSelectPage', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.selectTenant.mockReset();
    mocks.authState.memberships = [];
  });

  it('没有成员关系时展示空状态', () => {
    renderWithProviders(<TenantSelectPage />);

    expect(screen.getByText('当前平台账号还没有分配任何租户成员关系')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '前往租户管理' })).toBeInTheDocument();
  });

  it('可以进入激活租户工作台', async () => {
    mocks.authState.memberships = [
      {
        membership: {
          id: 1,
          tenantId: 18,
          platformUserId: 1,
          membershipRole: 'owner',
          systemRole: 'admin',
          status: 'active',
          createdAt: '2026-04-16T10:00:00.000Z',
          updatedAt: '2026-04-16T10:00:00.000Z',
        },
        tenant: {
          id: 18,
          tenantKey: 'acme',
          tenantName: 'Acme Corp',
          displayName: 'Acme Corp',
          status: 'active',
          businessDbPath: 'D:/data/acme.db',
          createdAt: '2026-04-16T10:00:00.000Z',
          updatedAt: '2026-04-16T10:00:00.000Z',
          provisionedAt: '2026-04-16T10:05:00.000Z',
          suspendedAt: null,
        },
      },
    ];
    mocks.selectTenant.mockResolvedValue({
      token: 'tenant-token',
      expiresAt: '2026-04-16T12:00:00.000Z',
      scope: 'tenant',
      user: {
        id: 1,
        username: 'tenant-admin',
        displayName: '租户管理员',
        role: 'admin',
        status: 'active',
        createdAt: '2026-04-16T10:00:00.000Z',
        updatedAt: '2026-04-16T10:00:00.000Z',
        lastLoginAt: null,
      },
      tenant: mocks.authState.memberships[0].tenant,
      membership: mocks.authState.memberships[0].membership,
    });

    const user = userEvent.setup();
    renderWithProviders(<TenantSelectPage />);

    await user.click(screen.getByRole('button', { name: /进入租户工作台/ }));

    await waitFor(() => {
      expect(mocks.selectTenant).toHaveBeenCalledWith(18);
      expect(mocks.navigate).toHaveBeenCalledWith('/dashboard', { replace: true });
    });
  });

  it('暂停中的租户不可直接进入', () => {
    mocks.authState.memberships = [
      {
        membership: {
          id: 2,
          tenantId: 21,
          platformUserId: 1,
          membershipRole: 'admin',
          systemRole: 'operator',
          status: 'active',
          createdAt: '2026-04-16T10:00:00.000Z',
          updatedAt: '2026-04-16T10:00:00.000Z',
        },
        tenant: {
          id: 21,
          tenantKey: 'suspended',
          tenantName: 'Suspended Corp',
          displayName: 'Suspended Corp',
          status: 'suspended',
          businessDbPath: 'D:/data/suspended.db',
          createdAt: '2026-04-16T10:00:00.000Z',
          updatedAt: '2026-04-16T10:00:00.000Z',
          provisionedAt: '2026-04-16T10:05:00.000Z',
          suspendedAt: '2026-04-16T11:00:00.000Z',
        },
      },
    ];

    renderWithProviders(<TenantSelectPage />);

    expect(screen.getByRole('button', { name: /进入租户工作台/ })).toBeDisabled();
  });
});
