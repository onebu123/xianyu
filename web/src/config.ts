function normalizeBasePath(path: string | undefined) {
  if (!path || path === '/') {
    return '/';
  }

  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

function normalizeApiBasePath(path: string | undefined) {
  if (!path || path === '/') {
    return '';
  }

  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

export const appBasePath = normalizeBasePath(import.meta.env.BASE_URL);
export const routerBasename = appBasePath === '/' ? '/' : appBasePath.replace(/\/$/, '');
export const apiBasePath = normalizeApiBasePath(
  import.meta.env.VITE_API_BASE_URL ??
    `${routerBasename === '/' ? '' : routerBasename}/api`,
);

export function resolveApiPath(path: string) {
  if (/^https?:\/\//.test(path)) {
    return path;
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (!apiBasePath) {
    return normalizedPath;
  }

  if (normalizedPath === '/api') {
    return apiBasePath;
  }

  if (normalizedPath.startsWith('/api/')) {
    return `${apiBasePath}${normalizedPath.slice('/api'.length)}`;
  }

  return `${apiBasePath}${normalizedPath}`;
}
