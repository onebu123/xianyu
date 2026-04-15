// API 请求客户端工具函数

import { resolveApiPath } from '../config';
import type { FilterQuery } from './types/filter.types';

const DEFAULT_TIMEOUT_MS = 30_000;

export async function apiRequest<T>(
  path: string,
  options?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const shouldAttachJsonContentType =
    options?.body !== undefined &&
    options?.body !== null &&
    !(options.body instanceof FormData) &&
    !(options.body instanceof URLSearchParams) &&
    !(options.body instanceof Blob);

  // 超时控制
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(resolveApiPath(path), {
      ...options,
      credentials: 'include',
      signal: controller.signal,
      headers: {
        ...(shouldAttachJsonContentType ? { 'Content-Type': 'application/json' } : {}),
        ...(options?.headers ?? {}),
      },
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({ message: '请求失败' }));
      throw new Error(payload.message ?? '请求失败');
    }

    if (response.headers.get('content-type')?.includes('text/csv')) {
      return (await response.text()) as T;
    }

    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}秒），请检查网络连接后重试。`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function buildQuery(query: FilterQuery) {
  const search = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== '' && value !== null) {
      if (Array.isArray(value)) {
        if (value.length > 0) {
          search.set(key, value.join(','));
        }
        return;
      }
      search.set(key, String(value));
    }
  });
  return search.toString();
}
