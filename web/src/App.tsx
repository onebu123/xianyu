import { Suspense, type ReactNode } from 'react';
import { Spin } from 'antd';
import { Navigate, Route, BrowserRouter as Router, Routes, useLocation } from 'react-router-dom';

import { AuthProvider, useAuth } from './auth';
import { canAccessPath, getFirstAccessiblePath } from './access';
import { routerBasename } from './config';
import { AppLayout } from './layout/AppLayout';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  protectedRoutes,
  platformRoutes,
  FeatureWorkspacePage,
  StoreAuthorizePage,
  TenantSelectPage,
  LoginPage,
} from './routes';

function RouteFallback() {
  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <Spin size="large" />
    </div>
  );
}

function ProtectedRoute() {
  const location = useLocation();
  const { loading, memberships, scope, user } = useAuth();

  const tenantWorkspaceHome = getFirstAccessiblePath(user?.role);
  const platformHome = memberships.length > 0 ? '/auth/select-tenant' : '/platform/tenants';

  if (loading) {
    return <RouteFallback />;
  }

  if (!scope) {
    return <Navigate to="/login" replace />;
  }

  if (scope === 'platform') {
    if (
      location.pathname === '/auth/select-tenant' ||
      location.pathname.startsWith('/platform/')
    ) {
      return <AppLayout />;
    }

    return <Navigate to={platformHome} replace />;
  }

  if (location.pathname === '/auth/select-tenant' || location.pathname.startsWith('/platform/')) {
    return <Navigate to={tenantWorkspaceHome} replace />;
  }

  if (!canAccessPath(user?.role, location.pathname)) {
    return <Navigate to={tenantWorkspaceHome} replace />;
  }

  return <AppLayout />;
}

function ProtectedPopupRoute({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { loading, memberships, scope, user } = useAuth();

  if (loading) {
    return <RouteFallback />;
  }

  if (!scope) {
    return <Navigate to="/login" replace />;
  }

  if (scope === 'platform') {
    return <Navigate to={memberships.length > 0 ? '/auth/select-tenant' : '/platform/tenants'} replace />;
  }

  if (!canAccessPath(user?.role, location.pathname)) {
    return <Navigate to={getFirstAccessiblePath(user?.role)} replace />;
  }

  return <>{children}</>;
}

function LoginRoute() {
  const { loading, memberships, scope, user } = useAuth();

  if (loading) {
    return <RouteFallback />;
  }

  if (scope === 'platform') {
    return <Navigate to={memberships.length > 0 ? '/auth/select-tenant' : '/platform/tenants'} replace />;
  }

  if (scope && user) {
    return <Navigate to={getFirstAccessiblePath(user?.role)} replace />;
  }

  return <LoginPage />;
}

function HomeRoute() {
  const { loading, memberships, scope, user } = useAuth();

  if (loading) {
    return <RouteFallback />;
  }

  if (!scope) {
    return <Navigate to="/login" replace />;
  }

  if (scope === 'platform') {
    return <Navigate to={memberships.length > 0 ? '/auth/select-tenant' : '/platform/tenants'} replace />;
  }

  return <Navigate to={getFirstAccessiblePath(user?.role)} replace />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <Router basename={routerBasename}>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/login" element={<LoginRoute />} />
              <Route
                path="/stores/connect/:platform"
                element={
                  <ProtectedPopupRoute>
                    <StoreAuthorizePage />
                  </ProtectedPopupRoute>
                }
              />
              <Route element={<ProtectedRoute />}>
                <Route path="/" element={<HomeRoute />} />
                <Route path="/auth/select-tenant" element={<TenantSelectPage />} />
                {protectedRoutes.map(({ path, component: Component }) => (
                  <Route key={path} path={path} element={<Component />} />
                ))}
                {platformRoutes.map(({ path, component: Component }) => (
                  <Route key={path} path={path} element={<Component />} />
                ))}
                <Route path="/workspace/:featureKey" element={<FeatureWorkspacePage />} />
              </Route>
            </Routes>
          </Suspense>
        </Router>
      </AuthProvider>
    </ErrorBoundary>
  );
}
