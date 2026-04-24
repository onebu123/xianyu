import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../test/render';
import { LoginPage } from './LoginPage';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('../auth', () => ({
  useAuth: () => ({
    login: mocks.login,
  }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

describe('LoginPage', () => {
  beforeEach(() => {
    mocks.login.mockReset();
    mocks.navigate.mockReset();
  });

  it('平台账号登录后会进入租户选择页', async () => {
    mocks.login.mockResolvedValue({
      token: 'platform-token',
      expiresAt: '2026-04-16T12:00:00.000Z',
      scope: 'platform',
      user: {
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
      memberships: [
        {
          membership: {
            id: 1,
            tenantId: 11,
            platformUserId: 1,
            membershipRole: 'owner',
            systemRole: 'admin',
            status: 'active',
            createdAt: '2026-04-16T10:00:00.000Z',
            updatedAt: '2026-04-16T10:00:00.000Z',
          },
          tenant: {
            id: 11,
            tenantKey: 'acme',
            tenantName: 'Acme',
            displayName: 'Acme',
            status: 'active',
            businessDbPath: 'D:/data/acme.db',
            createdAt: '2026-04-16T10:00:00.000Z',
            updatedAt: '2026-04-16T10:00:00.000Z',
            provisionedAt: '2026-04-16T10:05:00.000Z',
            suspendedAt: null,
          },
        },
      ],
      nextStep: 'select_tenant',
    });

    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByPlaceholderText('请输入用户名'), 'platform-admin');
    await user.type(screen.getByPlaceholderText('请输入密码'), 'PlatformPass@2026');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));

    await waitFor(() => {
      expect(mocks.login).toHaveBeenCalledWith('platform-admin', 'PlatformPass@2026');
      expect(mocks.navigate).toHaveBeenCalledWith('/auth/select-tenant', { replace: true });
    });
  });

  it('私有化账号登录后会进入首个业务页面', async () => {
    mocks.login.mockResolvedValue({
      token: 'private-token',
      expiresAt: '2026-04-16T12:00:00.000Z',
      scope: 'private',
      user: {
        id: 9,
        username: 'tenant-admin',
        displayName: '租户管理员',
        role: 'admin',
        status: 'active',
        createdAt: '2026-04-16T10:00:00.000Z',
        updatedAt: '2026-04-16T10:00:00.000Z',
        lastLoginAt: null,
      },
    });

    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByPlaceholderText('请输入用户名'), 'tenant-admin');
    await user.type(screen.getByPlaceholderText('请输入密码'), 'TenantPass@2026');
    await user.click(screen.getByRole('button', { name: /登\s*录/ }));

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith('/dashboard', { replace: true });
    });
  });
});
