import { useCallback, useMemo } from 'react';
import { apiRequest } from '../api';
import type { WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from './useRemoteData';

/** overview + detail 双接口加载（detail 可选） */
export interface WorkspaceDataResult<D> {
  overview: WorkspaceOverviewResponse | null;
  detail: D | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** 从 detail.metrics 提取的 SummaryCards items */
  summaryItems: { key: string; label: string; value: number; unit: string }[];
}

interface MetricsCarrier {
  metrics?: Array<{ label: string; value: string | number; unit: string }>;
}

/**
 * 工作台页面通用数据加载 Hook
 * - featureKey: 如 'card-combos'
 * - withDetail: 是否加载 /detail 接口（默认 true）
 */
export function useWorkspaceData<D extends MetricsCarrier = MetricsCarrier>(
  featureKey: string,
  withDetail = true,
): WorkspaceDataResult<D> {
  const loader = useCallback(async () => {
    const overviewP = apiRequest<WorkspaceOverviewResponse>(
      `/api/workspaces/${featureKey}`,
    );
    if (!withDetail) {
      const overview = await overviewP;
      return { overview, detail: null as D | null };
    }
    const [overview, detail] = await Promise.all([
      overviewP,
      apiRequest<D>(`/api/workspaces/${featureKey}/detail`, undefined),
    ]);
    return { overview, detail };
  }, [featureKey, withDetail]);

  const { data, loading, error, reload } = useRemoteData(loader);

  const summaryItems = useMemo(() => {
    const metrics = data?.detail?.metrics ?? [];
    return metrics.map((m, i) => ({
      key: `metric-${i}`,
      label: m.label,
      value: typeof m.value === 'string' ? parseFloat(m.value) || 0 : m.value,
      unit: m.unit,
    }));
  }, [data]);

  return {
    overview: data?.overview ?? null,
    detail: data?.detail ?? null,
    loading,
    error,
    reload,
    summaryItems,
  };
}

/**
 * overview-only 页面的 summary（从 overview.summary 提取）
 */
export function useOverviewSummary(overview: WorkspaceOverviewResponse | null) {
  return useMemo(() => {
    if (!overview?.summary) return [];
    return overview.summary.map((s, i) => ({
      key: `s-${i}`,
      label: s.label,
      value: typeof s.value === 'string' ? parseFloat(s.value) || 0 : s.value,
      unit: '',
    }));
  }, [overview]);
}
