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
  FeatureWorkspacePage,
  StoreAuthorizePage,
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
  const { loading, user } = useAuth();

  if (loading) {
    return <RouteFallback />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (!canAccessPath(user?.role, location.pathname)) {
    return <Navigate to={getFirstAccessiblePath(user?.role)} replace />;
  }

  return <AppLayout />;
}

function ProtectedPopupRoute({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { loading, user } = useAuth();

  if (loading) {
    return <RouteFallback />;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (!canAccessPath(user?.role, location.pathname)) {
    return <Navigate to={getFirstAccessiblePath(user?.role)} replace />;
  }

  return <>{children}</>;
}

function LoginRoute() {
  const { loading, user } = useAuth();

  if (loading) {
    return <RouteFallback />;
  }

  if (user) {
    return <Navigate to={getFirstAccessiblePath(user?.role)} replace />;
  }

  return <LoginPage />;
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
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                {protectedRoutes.map(({ path, component: Component }) => (
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
