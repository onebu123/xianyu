/* eslint-disable react-refresh/only-export-components */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import type {
  AuthProfileResponse,
  AuthScope,
  AuthUser,
  LoginResponse,
  PlatformMfaChallengeResponse,
  PlatformSessionResponse,
  PlatformAuthUser,
  PrivateSessionResponse,
  TenantAccessItem,
  TenantMembership,
  TenantSessionResponse,
  TenantSummary,
} from './api';
import { apiRequest } from './api';

interface AuthState {
  expiresAt: string | null;
  scope: AuthScope | null;
  user: AuthUser | null;
  platformUser: PlatformAuthUser | null;
  tenant: TenantSummary | null;
  membership: TenantMembership | null;
  memberships: TenantAccessItem[];
}

interface AuthContextValue extends AuthState {
  loading: boolean;
  login: (username: string, password: string) => Promise<LoginResponse>;
  selectTenant: (tenantId: number) => Promise<TenantSessionResponse>;
  refreshProfile: () => Promise<void>;
  logout: () => Promise<void>;
}

const LEGACY_STORAGE_KEYS = [
  'goofish-statistics-token',
  'goofish-statistics-user',
  'goofish-statistics-expires-at',
] as const;
const SESSION_HINT_STORAGE_KEY = 'goofish-statistics-session-hint';

const emptyAuthState: AuthState = {
  expiresAt: null,
  scope: null,
  user: null,
  platformUser: null,
  tenant: null,
  membership: null,
  memberships: [],
};

const AuthContext = createContext<AuthContextValue | null>(null);

function clearLegacyStoredAuth() {
  for (const key of LEGACY_STORAGE_KEYS) {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  }
}

function setSessionHint(enabled: boolean) {
  if (enabled) {
    localStorage.setItem(SESSION_HINT_STORAGE_KEY, '1');
    return;
  }

  localStorage.removeItem(SESSION_HINT_STORAGE_KEY);
}

function hasSessionHint() {
  return localStorage.getItem(SESSION_HINT_STORAGE_KEY) === '1';
}

function mapProfileToState(profile: AuthProfileResponse, expiresAt: string | null): AuthState {
  if (profile.scope === 'private') {
    return {
      expiresAt,
      scope: 'private',
      user: profile.user,
      platformUser: null,
      tenant: null,
      membership: null,
      memberships: [],
    };
  }

  if (profile.scope === 'platform') {
    return {
      expiresAt,
      scope: 'platform',
      user: null,
      platformUser: profile.user,
      tenant: null,
      membership: null,
      memberships: profile.memberships,
    };
  }

  return {
    expiresAt,
    scope: 'tenant',
    user: profile.user,
    platformUser: profile.platformUser,
    tenant: profile.tenant,
    membership: profile.membership,
    memberships: profile.memberships,
  };
}

type SessionStatePayload = Exclude<LoginResponse, PlatformMfaChallengeResponse>;

function mapSessionToState(payload: SessionStatePayload): AuthState {
  if (payload.scope === 'private') {
    return {
      expiresAt: payload.expiresAt,
      scope: 'private',
      user: payload.user,
      platformUser: null,
      tenant: null,
      membership: null,
      memberships: [],
    };
  }

  if (payload.scope === 'platform') {
    return {
      expiresAt: payload.expiresAt,
      scope: 'platform',
      user: null,
      platformUser: payload.user,
      tenant: null,
      membership: null,
      memberships: payload.memberships,
    };
  }

  return {
    expiresAt: payload.expiresAt,
    scope: 'tenant',
    user: payload.user,
    platformUser: null,
    tenant: payload.tenant,
    membership: payload.membership,
    memberships: [],
  };
}

type RefreshSessionResponse = PrivateSessionResponse | PlatformSessionResponse | TenantSessionResponse;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [authState, setAuthState] = useState<AuthState>(emptyAuthState);

  const persistSession = useCallback((state: AuthState) => {
    setAuthState(state);
    setSessionHint(true);
    clearLegacyStoredAuth();
  }, []);

  const clearSession = useCallback(() => {
    setAuthState(emptyAuthState);
    setSessionHint(false);
    clearLegacyStoredAuth();
  }, []);

  const refreshProfile = useCallback(async () => {
    const profile = await apiRequest<AuthProfileResponse>('/api/auth/profile', undefined);
    setAuthState((current) => mapProfileToState(profile, current.expiresAt));
  }, []);

  const refreshSession = useCallback(async () => {
    const payload = await apiRequest<RefreshSessionResponse>('/api/auth/refresh', {
      method: 'POST',
      body: '{}',
    });
    persistSession(mapSessionToState(payload));
    if (payload.scope === 'platform' || payload.scope === 'tenant') {
      const profile = await apiRequest<AuthProfileResponse>('/api/auth/profile', undefined);
      persistSession(mapProfileToState(profile, payload.expiresAt));
    }
    return payload;
  }, [persistSession]);

  const login = useCallback(
    async (username: string, password: string) => {
      const payload = await apiRequest<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      if (payload.scope !== 'platform_mfa') {
        persistSession(mapSessionToState(payload));
      }
      return payload;
    },
    [persistSession],
  );

  const selectTenant = useCallback(
    async (tenantId: number) => {
      const payload = await apiRequest<TenantSessionResponse>('/api/auth/select-tenant', {
        method: 'POST',
        body: JSON.stringify({ tenantId }),
      });
      persistSession(mapSessionToState(payload));
      const profile = await apiRequest<AuthProfileResponse>('/api/auth/profile', undefined);
      persistSession(mapProfileToState(profile, payload.expiresAt));
      return payload;
    },
    [persistSession],
  );

  const logout = useCallback(async () => {
    await apiRequest('/api/auth/logout', {
      method: 'POST',
      body: '{}',
      timeoutMs: 3000,
    });
    clearSession();
  }, [clearSession]);

  useEffect(() => {
    clearLegacyStoredAuth();

    let cancelled = false;

    async function bootstrapSession() {
      if (!hasSessionHint()) {
        if (!cancelled) {
          setLoading(false);
        }
        return;
      }

      try {
        await refreshSession();
      } catch {
        if (!cancelled) {
          clearSession();
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void bootstrapSession();

    return () => {
      cancelled = true;
    };
  }, [clearSession, refreshSession]);

  useEffect(() => {
    if (!authState.scope || !authState.expiresAt) {
      return;
    }

    const refreshAt = new Date(authState.expiresAt).getTime() - Date.now() - 5 * 60 * 1000;
    const timeout = window.setTimeout(
      async () => {
        try {
          await refreshSession();
        } catch {
          clearSession();
        }
      },
      Math.max(refreshAt, 15 * 1000),
    );

    return () => {
      window.clearTimeout(timeout);
    };
  }, [authState.expiresAt, authState.scope, clearSession, refreshSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      loading,
      ...authState,
      login,
      selectTenant,
      refreshProfile,
      logout,
    }),
    [authState, loading, login, logout, refreshProfile, selectTenant],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth 必须在 AuthProvider 内部使用');
  }
  return context;
}
