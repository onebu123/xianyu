/* eslint-disable react-refresh/only-export-components */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import type { LoginResponse } from './api';
import { apiRequest } from './api';

interface AuthContextValue {
  loading: boolean;
  expiresAt: string | null;
  user: LoginResponse['user'] | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const LEGACY_STORAGE_KEYS = [
  'goofish-statistics-token',
  'goofish-statistics-user',
  'goofish-statistics-expires-at',
] as const;
const SESSION_HINT_STORAGE_KEY = 'goofish-statistics-session-hint';

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [user, setUser] = useState<LoginResponse['user'] | null>(null);

  const persistSession = useCallback((payload: LoginResponse) => {
    setExpiresAt(payload.expiresAt);
    setUser(payload.user);
    setSessionHint(true);
    clearLegacyStoredAuth();
  }, []);

  const clearSession = useCallback(() => {
    setExpiresAt(null);
    setUser(null);
    setSessionHint(false);
    clearLegacyStoredAuth();
  }, []);

  const refreshSession = useCallback(async () => {
    const payload = await apiRequest<LoginResponse>('/api/auth/refresh', {
      method: 'POST',
      body: '{}',
    });
    persistSession(payload);
    return payload;
  }, [persistSession]);

  const login = useCallback(
    async (username: string, password: string) => {
      const payload = await apiRequest<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      persistSession(payload);
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
    if (!user || !expiresAt) {
      return;
    }

    const refreshAt = new Date(expiresAt).getTime() - Date.now() - 5 * 60 * 1000;
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
  }, [clearSession, expiresAt, refreshSession, user]);

  const value = useMemo<AuthContextValue>(
    () => ({
      loading,
      expiresAt,
      user,
      login,
      logout,
    }),
    [expiresAt, loading, login, logout, user],
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
